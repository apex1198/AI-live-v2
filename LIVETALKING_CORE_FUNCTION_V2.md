# LiveTalking Core Function - V2

## Mục tiêu

LiveTalking là core runtime của IDOL livestream. V2 không được coi LiveTalking là một service phụ có thể gọi tùy thời điểm. Hệ thống phải đảm bảo:

- Worker LiveTalking được khởi động và giữ hoạt động trong suốt vòng đời livestream.
- Chỉ cho phép phát audio, video hoặc speech khi worker đã `READY` và WebRTC session hợp lệ.
- Tự phát hiện worker/session bị mất và tự khôi phục.
- Không để frontend nhận lỗi mơ hồ `No active LiveTalking WebRTC session`.
- Khi chưa thể khôi phục, hệ thống phải trả về trạng thái rõ ràng và giữ livestream ở trạng thái an toàn.

## Phạm vi

Bao gồm:

- LiveTalking Python worker.
- Runtime server và worker supervisor.
- WebRTC signaling và session lifecycle.
- Audio/TTS pipeline gửi dữ liệu vào LiveTalking.
- Dashboard/operator status.
- Health check, readiness, logging, metrics và cảnh báo.

Không bao gồm việc thay thế model inference hoặc thay đổi thuật toán lip-sync.

## Nguyên tắc bắt buộc

1. **Worker readiness khác với process alive**

   Process còn tồn tại không có nghĩa LiveTalking đã sẵn sàng. Worker chỉ được xem là `READY` sau khi:

   - HTTP server phản hồi health.
   - Model đã load xong.
   - Avatar mặc định đã load xong.
   - Endpoint `/offer` có thể tạo WebRTC session.

2. **Không cache session vô thời hạn**

   `sessionId` chỉ là thông tin tạm thời. Mọi request dùng session phải xác nhận session còn tồn tại hoặc xử lý recovery khi nhận lỗi `404`, `session not found`, `closed`, `ERROR` hoặc timeout.

3. **Một nơi duy nhất quản lý session**

   Frontend không tự tạo nhiều session song song. Runtime giữ session hiện tại, điều phối reconnect và phát sự kiện trạng thái cho frontend.

4. **Không phát sinh speech khi core chưa sẵn sàng**

   Speech command phải được queue hoặc từ chối có kiểm soát nếu LiveTalking chưa `READY`. Không gọi `/speak` hoặc `/humanaudio` với `sessionid` rỗng.

5. **Recovery phải idempotent**

   Nhiều request cùng phát hiện mất session chỉ được tạo một phiên recovery duy nhất. Các request còn lại phải chờ kết quả recovery đó.

## State machine

### Worker state

```text
OFFLINE
   -> STARTING
   -> LOADING
   -> READY
   -> DEGRADED
   -> RESTARTING
   -> ERROR
```

- `OFFLINE`: chưa chạy hoặc đã dừng.
- `STARTING`: process đang được tạo.
- `LOADING`: process sống nhưng model/avatar chưa sẵn sàng.
- `READY`: có thể tạo WebRTC session.
- `DEGRADED`: process còn sống nhưng health/readiness hoặc inference không ổn định.
- `RESTARTING`: supervisor đang dừng và tạo lại worker.
- `ERROR`: không thể khởi động sau số lần retry cho phép.

### WebRTC session state

```text
NONE -> CONNECTING -> ACTIVE -> RECONNECTING -> ACTIVE
                         \-> EXPIRED
                         \-> FAILED
```

`ACTIVE` chỉ được xác nhận sau khi offer/answer hoàn tất và worker trả về `sessionid` hợp lệ. `sessionid` xuất hiện trong memory nhưng chưa handshake xong không được coi là `ACTIVE`.

## Kiến trúc V2 đề xuất

```text
Runtime Server
    |
    +-- LiveTalkingSupervisor
    |      +-- start / stop / restart
    |      +-- health polling
    |      +-- exponential backoff
    |      +-- process exit detection
    |
    +-- LiveTalkingSessionController
    |      +-- ensureWorkerReady()
    |      +-- ensureSession()
    |      +-- reconnect()
    |      +-- single-flight recovery lock
    |
    +-- Speech/TTS Pipeline
    |      +-- awaitReady()
    |      +-- sendAudioWithRecovery()
    |
    +-- WebSocket/Event API
           +-- worker state
           +-- session state
           +-- user-visible recovery error
```

## Worker supervisor

### Startup

Khi runtime khởi động:

1. Đọc endpoint và cấu hình model/avatar.
2. Kiểm tra worker bên ngoài đã chạy chưa.
3. Nếu chưa chạy và runtime được phép quản lý process, khởi động worker.
4. Poll readiness với timeout cấu hình được.
5. Chỉ đánh dấu runtime `READY` sau khi readiness thành công.
6. Phát sự kiện `LIVETALKING_WORKER_READY`.

Nếu worker bên ngoài được deploy bằng Docker/systemd, runtime không tự spawn process mà chỉ health-check và tự reconnect client. Cơ chế restart process thuộc Docker/systemd với policy `restart: unless-stopped` hoặc tương đương.

### Liveness loop

- Poll health mỗi 2-5 giây.
- Không cho phép nhiều health poll chồng lên nhau.
- Khi health fail, chuyển sang `DEGRADED` ngay lập tức.
- Retry readiness theo exponential backoff, ví dụ: `1s, 2s, 5s, 10s, 30s`.
- Giới hạn restart để tránh vòng lặp vô hạn khi thiếu model/avatar.
- Lưu nguyên nhân lỗi gần nhất, thời điểm lỗi và số lần restart.

### Readiness endpoint

Worker nên cung cấp hai khái niệm riêng:

- `/health`: process còn phản hồi.
- `/ready`: model, avatar và inference engine đã sẵn sàng.

Runtime chỉ dùng `/ready` để cho phép tạo session mới.

## Session controller

### `ensureSession()`

Mọi đường dẫn gửi audio, speech hoặc kiểm tra speaking phải đi qua `ensureSession()`:

```ts
async function ensureSession(): Promise<string> {
  await supervisor.ensureReady();

  if (currentSession && await isSessionUsable(currentSession)) {
    return currentSession;
  }

  return recoverSessionOnce();
}
```

`recoverSessionOnce()` phải dùng single-flight lock/promise:

```ts
if (recoveryPromise) return recoveryPromise;

recoveryPromise = reconnectWebRTC()
  .finally(() => { recoveryPromise = null; });

return recoveryPromise;
```

### Khi session mất

Khi nhận một trong các tín hiệu sau:

- HTTP `404` hoặc `410`.
- `session not found`.
- WebRTC `connectionState` là `failed`, `disconnected` quá thời gian cho phép hoặc `closed`.
- Worker trả session state `ERROR` hoặc `EXPIRED`.
- Không nhận frame/heartbeat trong timeout cấu hình được.

Hệ thống phải:

1. Đánh dấu session hiện tại là stale.
2. Ngừng gửi request mới vào session đó.
3. Tạo lại WebRTC offer/answer.
4. Cập nhật session atomically.
5. Replay audio chưa phát nếu còn hợp lệ và chưa bị duplicate.
6. Phát trạng thái reconnect cho frontend.

Không được ghi đè session đang hoạt động bằng một session mới chỉ vì một health poll tạm thời thất bại.

## Audio và speech pipeline

### Quy tắc gửi audio

- Không gửi `/humanaudio` nếu chưa có session hợp lệ.
- Mỗi audio job có `commandId` và `audioId` để chống gửi trùng.
- Khi upload gặp lỗi session, retry bằng session mới tối đa số lần cấu hình được.
- Chỉ replay audio hiện tại; không replay toàn bộ queue nếu không có yêu cầu.
- Khi recovery thất bại, chuyển speech command sang `ERROR` với mã lỗi có cấu trúc.

### Mã lỗi cần thống nhất

```text
LIVETALKING_WORKER_OFFLINE
LIVETALKING_WORKER_NOT_READY
LIVETALKING_SESSION_CONNECTING
LIVETALKING_SESSION_EXPIRED
LIVETALKING_SESSION_RECOVERY_FAILED
LIVETALKING_AUDIO_REJECTED
```

Frontend hiển thị thông báo theo mã lỗi, không hiển thị trực tiếp exception nội bộ.

## Frontend/operator behavior

Dashboard phải hiển thị tối thiểu:

- Worker: `Offline`, `Starting`, `Loading`, `Ready`, `Degraded`, `Restarting`, `Error`.
- WebRTC: `Disconnected`, `Connecting`, `Live`, `Reconnecting`, `Failed`.
- Avatar hiện tại.
- Thời điểm health check gần nhất.
- Số lần reconnect/restart.
- Lỗi gần nhất và nút `Retry connection`.

Trong lúc `RECONNECTING`:

- Disable nút gửi speech mới hoặc đưa speech vào queue có giới hạn.
- Không tạo thêm WebRTC peer connection song song.
- Giữ trạng thái livestream rõ ràng để operator biết hệ thống đang tự phục hồi.

## Graceful degradation

Nếu không thể khôi phục LiveTalking:

- Không làm sập runtime server.
- Giữ chat, moderation, OBS và các chức năng không phụ thuộc avatar hoạt động.
- Đánh dấu speech/video là unavailable.
- Có thể chuyển sang audio-only hoặc mock provider nếu policy của sản phẩm cho phép.
- Không giả vờ trạng thái `LIVE` khi avatar không xuất frame.

Fallback phải là cấu hình rõ ràng, mặc định không được che giấu lỗi core function.

## Observability

Log có cấu trúc, kèm các trường:

```json
{
  "component": "livetalking",
  "workerState": "READY",
  "sessionState": "ACTIVE",
  "sessionId": "redacted-or-short-id",
  "commandId": "speech_xxx",
  "attempt": 2,
  "event": "session_recovered"
}
```

Metrics tối thiểu:

- `livetalking_worker_ready`.
- `livetalking_worker_restart_total`.
- `livetalking_session_connect_total`.
- `livetalking_session_reconnect_total`.
- `livetalking_session_recovery_failure_total`.
- `livetalking_active_sessions`.
- `livetalking_audio_replay_total`.
- `livetalking_time_to_ready_ms`.
- `livetalking_time_to_recover_ms`.

Không ghi access token, SDP đầy đủ, audio bytes hoặc dữ liệu nhạy cảm vào log.

## Cấu hình đề xuất

```env
LIVETALKING_REQUIRED=true
LIVETALKING_ENDPOINT=http://127.0.0.1:8011
LIVETALKING_READY_TIMEOUT_MS=180000
LIVETALKING_HEALTH_INTERVAL_MS=3000
LIVETALKING_SESSION_TIMEOUT_MS=15000
LIVETALKING_RECONNECT_MAX_ATTEMPTS=5
LIVETALKING_RESTART_MAX_ATTEMPTS=3
LIVETALKING_AUDIO_REPLAY_MAX_ATTEMPTS=2
LIVETALKING_QUEUE_WHILE_RECONNECTING=true
LIVETALKING_MAX_QUEUED_SPEECH=3
```

## Test bắt buộc

### Unit test

- Worker health fail rồi hồi phục.
- Worker process exit được supervisor phát hiện.
- Hai request đồng thời chỉ tạo một recovery session.
- Session cũ bị `404` thì audio được gửi lại đúng một lần trên session mới.
- Recovery thất bại trả đúng mã lỗi.
- Không gửi request với session ID rỗng.
- Session mới không ghi đè session active bởi health poll cũ.

### Integration test

- Runtime khởi động khi worker chưa chạy.
- Runtime chờ worker readiness trước khi nhận speech.
- WebRTC disconnect rồi tự reconnect.
- Worker restart trong lúc đang nói.
- Worker thiếu model/avatar và trả trạng thái `ERROR` rõ ràng.
- Nhiều speech command trong thời gian reconnect.
- Shutdown runtime không để lại process hoặc peer connection.

### Manual acceptance test

1. Start V2 khi LiveTalking đang tắt: UI phải hiển thị `Starting/Offline`, không hiện exception thô.
2. Bật LiveTalking: UI tự chuyển sang `Ready`, sau đó WebRTC kết nối được.
3. Tắt worker khi idol đang nói: UI chuyển `Reconnecting`, worker/session tự phục hồi.
4. Gửi speech ngay trong lúc reconnect: command được queue hoặc từ chối có mã rõ ràng.
5. Kiểm tra log và metrics: phải phân biệt worker restart với session reconnect.

## Definition of Done

V2 chỉ được coi là hoàn thành khi:

- Không còn flow production nào gọi trực tiếp LiveTalking mà bỏ qua `ensureWorkerReady()` và `ensureSession()`.
- Không còn lỗi người dùng phải tự xử lý bằng cách reload app.
- Worker restart và WebRTC reconnect được kiểm thử tự động.
- UI phản ánh đúng worker/session state.
- Có timeout, retry limit, backoff và single-flight recovery.
- Có graceful degradation nhưng không che giấu việc core function đang unavailable.
- Các lỗi `No active LiveTalking WebRTC session` được chuyển thành recovery hoặc mã lỗi sản phẩm có cấu trúc.

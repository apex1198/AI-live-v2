# Nhúng Unify Chat bằng iframe

```html
<div class="idol-chat-slot">
  <iframe
    id="idol-live-chat"
    title="AI Idol Unify Chat"
    src="http://127.0.0.1:6767/chat-embed.html?theme=dark&max=30&height=420"
    loading="lazy"
    allow="autoplay"
  ></iframe>
</div>

<style>
  .idol-chat-slot { width: 100%; min-width: 0; }
  .idol-chat-slot iframe {
    display: block;
    width: 100%;
    min-width: 0;
    height: 420px;
    border: 0;
  }
</style>

<script>
  window.addEventListener('message', (event) => {
    if (event.origin !== 'http://127.0.0.1:6767') return;
    if (event.data?.type !== 'AI_IDOL_CHAT_RESIZE') return;
    document.getElementById('idol-live-chat').style.height = `${event.data.height}px`;
  });
</script>
```

## Tuỳ chọn URL

- `theme=dark|light`
- `header=0|1`
- `transparent=0|1`
- `max=1..100`
- `height=190..1200`

Iframe chứa đúng panel **Unify Chat**: chat YouTube/Facebook, gửi tin nhắn thử, gửi quà và xóa danh sách hiển thị. Khung tự chiếm `100%` chiều ngang div cha. Khi div hẹp, hàng nhập liệu tự xuống dòng để không tạo thanh cuộn ngang.

Trang HTTPS thường chặn iframe HTTP do mixed content. Khi nhúng vào website HTTPS, runtime chat cũng cần được phục vụ qua HTTPS hoặc reverse proxy an toàn.

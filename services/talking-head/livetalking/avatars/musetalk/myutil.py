import numpy as np
import cv2


def _build_lip_color_mask(generated_lab, source_lab):
    height, width = generated_lab.shape[:2]
    yy, xx = np.ogrid[:height, :width]
    center_x = width * 0.5
    center_y = height * 0.70
    radius_x = max(1.0, width * 0.31)
    radius_y = max(1.0, height * 0.17)
    mouth_region = (((xx - center_x) / radius_x) ** 2 + ((yy - center_y) / radius_y) ** 2) <= 1.0

    valid_luma = (
        (generated_lab[:, :, 0] > 16)
        & (generated_lab[:, :, 0] < 242)
        & (source_lab[:, :, 0] > 16)
        & (source_lab[:, :, 0] < 242)
    )
    lower_face = (
        (xx >= width * 0.10)
        & (xx <= width * 0.90)
        & (yy >= height * 0.38)
        & (yy <= height * 0.92)
        & valid_luma
    )
    skin_region = lower_face & ~mouth_region
    if np.count_nonzero(skin_region) < 32:
        skin_region = valid_luma & ~mouth_region
    if np.count_nonzero(skin_region) < 32:
        return np.zeros((height, width), dtype=np.float32), mouth_region, mouth_region

    source_a = source_lab[:, :, 1]
    generated_a = generated_lab[:, :, 1]
    skin_a = float(np.median(source_a[skin_region]))
    source_lips = mouth_region & valid_luma & (source_a >= skin_a + 2.5)
    generated_lips = mouth_region & valid_luma & (generated_a >= skin_a + 4.0)
    lip_pixels = source_lips | generated_lips
    if np.count_nonzero(lip_pixels) < 12:
        return np.zeros((height, width), dtype=np.float32), source_lips, generated_lips

    binary = lip_pixels.astype(np.uint8) * 255
    kernel_size = max(3, int(round(min(height, width) * 0.035)))
    if kernel_size % 2 == 0:
        kernel_size += 1
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)
    binary = cv2.dilate(binary, kernel, iterations=1)
    sigma = max(0.8, min(height, width) * 0.018)
    soft_mask = cv2.GaussianBlur(binary.astype(np.float32) / 255.0, (0, 0), sigmaX=sigma, sigmaY=sigma)
    return np.clip(soft_mask, 0.0, 1.0), source_lips, generated_lips


def _build_lower_face_tone_mask(height, width):
    yy, xx = np.ogrid[:height, :width]
    center_x = width * 0.5
    center_y = height * 0.70
    radius_x = max(1.0, width * 0.44)
    radius_y = max(1.0, height * 0.30)
    binary = ((((xx - center_x) / radius_x) ** 2 + ((yy - center_y) / radius_y) ** 2) <= 1.0).astype(np.float32)
    sigma = max(1.0, min(height, width) * 0.035)
    return np.clip(cv2.GaussianBlur(binary, (0, 0), sigmaX=sigma, sigmaY=sigma), 0.0, 1.0)


def match_generated_face_color(face, source_face, temporal_state=None):
    """Match source lip chroma and lower-face tone without erasing lip motion."""
    if face is None or source_face is None or face.size == 0 or source_face.size == 0:
        return face

    height, width = face.shape[:2]
    if source_face.shape[:2] != (height, width):
        source_face = cv2.resize(source_face, (width, height), interpolation=cv2.INTER_LINEAR)

    generated_lab = cv2.cvtColor(face.astype(np.uint8), cv2.COLOR_BGR2LAB).astype(np.float32)
    source_lab = cv2.cvtColor(source_face.astype(np.uint8), cv2.COLOR_BGR2LAB).astype(np.float32)
    lip_mask, source_lips, generated_lips = _build_lip_color_mask(generated_lab, source_lab)
    tone_mask = _build_lower_face_tone_mask(height, width)

    has_lip_mask = float(lip_mask.max()) > 0.0
    if has_lip_mask:
        source_selection = source_lips if np.count_nonzero(source_lips) >= 12 else lip_mask >= 0.5
        generated_selection = generated_lips if np.count_nonzero(generated_lips) >= 12 else lip_mask >= 0.5
        source_ab = source_lab[:, :, 1:3][source_selection]
        generated_ab = generated_lab[:, :, 1:3][generated_selection]
        generated_center = np.median(generated_ab, axis=0)
        source_center = np.median(source_ab, axis=0)
        source_chroma = np.linalg.norm(source_ab - 128.0, axis=1)
        generated_chroma = np.linalg.norm(generated_ab - 128.0, axis=1)
        chroma_limit = float(np.percentile(source_chroma, 85)) * 1.02 + 1.0
        center_delta = float(np.linalg.norm(source_center - generated_center))
        chroma_delta = abs(float(np.percentile(source_chroma, 85)) - float(np.percentile(generated_chroma, 85)))
    else:
        generated_center = np.array([128.0, 128.0], dtype=np.float32)
        source_center = generated_center.copy()
        chroma_limit = 128.0
        center_delta = 0.0
        chroma_delta = 0.0

    blur_sigma = max(1.0, min(height, width) * 0.055)
    generated_luma = generated_lab[:, :, 0]
    source_luma = source_lab[:, :, 0]
    generated_low = cv2.GaussianBlur(generated_luma, (0, 0), sigmaX=blur_sigma, sigmaY=blur_sigma)
    source_low = cv2.GaussianBlur(source_luma, (0, 0), sigmaX=blur_sigma, sigmaY=blur_sigma)
    generated_detail = generated_luma - generated_low
    source_detail = source_luma - source_low
    tone_selection = tone_mask >= 0.45
    luma_delta = np.clip(source_low - generated_low, -18.0, 18.0)
    luma_center = float(np.median(luma_delta[tone_selection]))
    generated_detail_std = float(np.std(generated_detail[tone_selection])) + 0.25
    source_detail_std = float(np.std(source_detail[tone_selection])) + 0.25
    texture_gain = float(np.clip(source_detail_std / generated_detail_std, 0.82, 1.18))

    # Exact or already-matched colors should not lose natural lip texture.
    if center_delta < 1.25 and chroma_delta < 1.5 and abs(luma_center) < 0.75 and abs(texture_gain - 1.0) < 0.04:
        return face

    if temporal_state is not None:
        previous_source_center = temporal_state.get('source_center')
        previous_generated_center = temporal_state.get('generated_center')
        previous_limit = temporal_state.get('chroma_limit')
        previous_luma_center = temporal_state.get('luma_center')
        previous_texture_gain = temporal_state.get('texture_gain')
        if previous_source_center is not None:
            source_center = np.asarray(previous_source_center, dtype=np.float32) * 0.35 + source_center * 0.65
        if previous_generated_center is not None:
            generated_center = np.asarray(previous_generated_center, dtype=np.float32) * 0.35 + generated_center * 0.65
        if previous_limit is not None:
            chroma_limit = float(previous_limit) * 0.35 + chroma_limit * 0.65
        if previous_luma_center is not None:
            smoothed_luma_center = float(previous_luma_center) * 0.35 + luma_center * 0.65
            luma_delta += smoothed_luma_center - luma_center
            luma_center = smoothed_luma_center
        if previous_texture_gain is not None:
            texture_gain = float(previous_texture_gain) * 0.35 + texture_gain * 0.65
        temporal_state['source_center'] = source_center.copy()
        temporal_state['generated_center'] = generated_center.copy()
        temporal_state['chroma_limit'] = chroma_limit
        temporal_state['luma_center'] = luma_center
        temporal_state['texture_gain'] = texture_gain

    corrected_luma = generated_low + luma_delta * 0.88 + generated_detail * texture_gain * 0.90 + source_detail * 0.10
    generated_lab[:, :, 0] = np.clip(generated_luma * (1.0 - tone_mask) + corrected_luma * tone_mask, 0, 255)

    if has_lip_mask:
        original_ab = generated_lab[:, :, 1:3].copy()
        corrected_ab = source_center + (original_ab - generated_center) * 0.72
        corrected_chroma = np.linalg.norm(corrected_ab - 128.0, axis=2)
        chroma_scale = np.minimum(1.0, chroma_limit / np.maximum(corrected_chroma, 1.0))
        corrected_ab = 128.0 + (corrected_ab - 128.0) * chroma_scale[:, :, None]
        alpha = lip_mask[:, :, None]
        generated_lab[:, :, 1:3] = np.clip(original_ab * (1.0 - alpha) + corrected_ab * alpha, 0, 255)

    corrected_face = cv2.cvtColor(generated_lab.astype(np.uint8), cv2.COLOR_LAB2BGR)
    unchanged = np.maximum(tone_mask, lip_mask) < 0.02
    corrected_face[unchanged] = face[unchanged]
    return corrected_face


LOWER_FACE_FEATHER_MIN_PX = 5.0
LOWER_FACE_FEATHER_PX = 5.0
LOWER_FACE_FEATHER_FACE_RATIO = 0.0
LOWER_FACE_EDGE_PADDING_RATIO = 0.05
# Pull the face outline inward toward the mouth, rather than shrinking a
# rectangular mask. This keeps every edge in the mouth-to-face gap.
LOWER_FACE_OUTER_INSET_RATIO = 0.20
LIP_DETAIL_SHARPEN_STRENGTH = 0.45
LIP_DETAIL_PAD_PX = 0
# Paste-back is 1:1 with the tracked source geometry.  Do not enlarge the
# generated mouth support: even a small expansion lets the synthetic mouth
# overwrite the source chin and makes lips appear larger than the original.
MOUTH_MASK_REGION_SCALE = 1.0
MOUTH_MASK_EXPAND_PX = 0
MOUTH_MASK_PAD_X_PX = 0
MOUTH_MASK_PAD_Y_PX = 0
MEDIAPIPE_LIP_LANDMARK_INDICES = (
    0, 13, 14, 17, 37, 39, 40, 61, 78, 80, 81, 82, 84, 87, 88, 91,
    95, 146, 178, 181, 185, 191, 267, 269, 270, 291, 308, 310, 311,
    312, 314, 317, 318, 321, 324, 375, 402, 405, 409, 415,
)


def resolve_lower_face_feather_px(face_width, face_height):
    """Use the requested fixed inward feather for every face size."""
    return LOWER_FACE_FEATHER_PX


def _inward_feather(binary_mask, feather_px=LOWER_FACE_FEATHER_PX):
    """Feather inside the mask so generated pixels never leak over its edge."""
    binary = (binary_mask > 0).astype(np.uint8)
    if not np.any(binary):
        return binary.astype(np.float32)
    distance = cv2.distanceTransform(binary, cv2.DIST_L2, 5)
    return np.clip(distance / max(1.0, float(feather_px)), 0.0, 1.0).astype(np.float32)


def build_mediapipe_mouth_mask(
    alignment,
    width=256,
    height=256,
    pad_x=MOUTH_MASK_PAD_X_PX,
    pad_y=MOUTH_MASK_PAD_Y_PX,
    feather_px=LOWER_FACE_FEATHER_PX,
    edge_padding_ratio=LOWER_FACE_EDGE_PADDING_RATIO,
):
    """Build the lower-face compositing mask in aligned landmark space.

    MuseTalk generates a frontal mouth crop. Rather than pasting that crop
    into a perspective frame through an axis-aligned rectangle, the whole
    lower-face support is warped back with the frame homography. The support
    follows the face oval, starts below the nose, and stays five percent inside
    the outer face boundary so it cannot spill onto hair, ears, or background.

    ``pad_x`` and ``pad_y`` remain accepted for callers created with older
    avatars, but are deliberately not used by this geometry-based mask.
    """
    landmarks = np.asarray(alignment.get("landmarks", []), dtype=np.float32).reshape(-1, 2)
    if landmarks.shape[0] < 478:
        raise ValueError("MediaPipe 478 landmarks are required for the mouth mask")
    matrix = np.asarray(alignment.get("source_to_aligned"), dtype=np.float32)
    if matrix.shape != (3, 3):
        raise ValueError("A valid source_to_aligned perspective matrix is required")

    aligned = cv2.perspectiveTransform(landmarks.reshape(1, -1, 2), matrix).reshape(-1, 2)
    # Import here so this compositing helper remains independently importable
    # by legacy avatar code during application startup.
    from avatars.musetalk.utils.face_geometry import FACE_OVAL_INDICES

    oval = aligned[FACE_OVAL_INDICES].copy()
    oval[:, 0] = np.clip(oval[:, 0], 0, width - 1)
    oval[:, 1] = np.clip(oval[:, 1], 0, height - 1)
    mouth_center = np.mean(aligned[list(MEDIAPIPE_LIP_LANDMARK_INDICES)], axis=0)
    # A 20% face-relative inset is stable at profile angles. Unlike scaling a
    # mask bounding box, it pulls the chin and cheeks toward the real mouth.
    inset_ratio = max(float(edge_padding_ratio), LOWER_FACE_OUTER_INSET_RATIO)
    inset_oval = mouth_center + (oval - mouth_center) * (1.0 - inset_ratio)
    inset_oval[:, 0] = np.clip(inset_oval[:, 0], 0, width - 1)
    inset_oval[:, 1] = np.clip(inset_oval[:, 1], 0, height - 1)
    binary = np.zeros((height, width), dtype=np.uint8)
    cv2.fillPoly(binary, [np.round(inset_oval).astype(np.int32)], 255)

    face_width = max(1.0, float(np.ptp(inset_oval[:, 0])))
    face_height = max(1.0, float(np.ptp(inset_oval[:, 1])))
    edge_padding_px = max(1, int(round(min(np.ptp(oval[:, 0]), np.ptp(oval[:, 1])) * edge_padding_ratio)))

    # The upper boundary is high below the nose and smoothly descends toward
    # each cheek, yielding the curved lower-face region shown in the reference.
    nose_indices = np.array([2, 4, 5, 98, 327], dtype=np.int32)
    nose_bottom = float(np.max(aligned[nose_indices, 1]))
    mouth_center_x = float(mouth_center[0])
    center_x = float(np.clip(mouth_center_x, 0, width - 1))
    half_width = max(1.0, face_width * 0.5 - edge_padding_px)
    xx = np.arange(width, dtype=np.float32)
    top_curve = nose_bottom + (np.abs(xx - center_x) / half_width) ** 1.7 * face_height * 0.12
    yy = np.arange(height, dtype=np.float32)[:, None]
    binary[yy < top_curve[None, :]] = 0
    return np.round(_inward_feather(binary, feather_px) * 255.0).astype(np.uint8)


def scale_mask_region(binary_mask, scale):
    """Scale a binary mask around its own center without moving the overlay."""
    binary = (np.asarray(binary_mask) > 0).astype(np.uint8) * 255
    points = cv2.findNonZero(binary)
    if points is None:
        return binary
    x, y, width, height = cv2.boundingRect(points)
    factor = max(0.01, float(scale))
    target_width = max(1, int(round(width * factor)))
    target_height = max(1, int(round(height * factor)))
    scaled = cv2.resize(binary[y:y + height, x:x + width], (target_width, target_height), interpolation=cv2.INTER_NEAREST)
    center_x, center_y = x + width / 2.0, y + height / 2.0
    target_x, target_y = int(round(center_x - target_width / 2.0)), int(round(center_y - target_height / 2.0))
    output = np.zeros_like(binary)
    source_x, source_y = max(0, -target_x), max(0, -target_y)
    destination_x, destination_y = max(0, target_x), max(0, target_y)
    copy_width = min(target_width - source_x, output.shape[1] - destination_x)
    copy_height = min(target_height - source_y, output.shape[0] - destination_y)
    if copy_width > 0 and copy_height > 0:
        output[destination_y:destination_y + copy_height, destination_x:destination_x + copy_width] = scaled[source_y:source_y + copy_height, source_x:source_x + copy_width]
    return output


def build_mediapipe_lip_detail_mask(alignment, width=256, height=256, pad_px=LIP_DETAIL_PAD_PX):
    """Return a soft, local lip mask for detail restoration after generation."""
    landmarks = np.asarray(alignment.get("landmarks", []), dtype=np.float32).reshape(-1, 2)
    matrix = np.asarray(alignment.get("source_to_aligned"), dtype=np.float32)
    if landmarks.shape[0] < 478 or matrix.shape != (3, 3):
        return np.zeros((height, width), dtype=np.float32)
    aligned = cv2.perspectiveTransform(landmarks.reshape(1, -1, 2), matrix).reshape(-1, 2)
    lips = aligned[list(MEDIAPIPE_LIP_LANDMARK_INDICES)].copy()
    lips[:, 0] = np.clip(lips[:, 0], 0, width - 1)
    lips[:, 1] = np.clip(lips[:, 1], 0, height - 1)
    binary = np.zeros((height, width), dtype=np.uint8)
    cv2.fillConvexPoly(binary, cv2.convexHull(np.round(lips).astype(np.int32)), 255)
    pad = max(0, int(round(pad_px)))
    if pad:
        binary = cv2.dilate(
            binary,
            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (pad * 2 + 1, pad * 2 + 1)),
            iterations=1,
        )
    return np.clip(cv2.GaussianBlur(binary.astype(np.float32) / 255.0, (0, 0), 1.25), 0.0, 1.0)


def enhance_lip_detail(face, lip_mask, strength=LIP_DETAIL_SHARPEN_STRENGTH):
    """Restore fine lip contrast without sharpening the surrounding skin."""
    if face is None or face.size == 0 or lip_mask is None:
        return face
    mask = np.asarray(lip_mask, dtype=np.float32)
    if mask.shape[:2] != face.shape[:2]:
        mask = cv2.resize(mask, (face.shape[1], face.shape[0]), interpolation=cv2.INTER_LINEAR)
    mask = np.clip(mask, 0.0, 1.0)
    if float(mask.max()) <= 0.0:
        return face
    lab = cv2.cvtColor(face.astype(np.uint8), cv2.COLOR_BGR2LAB).astype(np.float32)
    luma = lab[:, :, 0]
    local_base = cv2.GaussianBlur(luma, (0, 0), sigmaX=1.1, sigmaY=1.1)
    detail = np.clip(luma - local_base, -24.0, 24.0)
    lab[:, :, 0] = np.clip(luma + detail * float(strength) * mask, 0.0, 255.0)
    return cv2.cvtColor(lab.astype(np.uint8), cv2.COLOR_LAB2BGR)


def expand_mask_region(
    binary_mask,
    scale=MOUTH_MASK_REGION_SCALE,
    expand_px=MOUTH_MASK_EXPAND_PX,
):
    """Scale a mask around its center, then expand its edge by fixed pixels."""
    binary = (binary_mask > 0).astype(np.uint8) * 255
    points = cv2.findNonZero(binary)
    if points is None:
        return binary

    x, y, width, height = cv2.boundingRect(points)
    target_width = max(width, int(round(width * max(1.0, float(scale)))))
    target_height = max(height, int(round(height * max(1.0, float(scale)))))
    scaled = cv2.resize(
        binary[y:y + height, x:x + width],
        (target_width, target_height),
        interpolation=cv2.INTER_NEAREST,
    )

    center_x = x + width / 2.0
    center_y = y + height / 2.0
    target_x = int(round(center_x - target_width / 2.0))
    target_y = int(round(center_y - target_height / 2.0))
    output = np.zeros_like(binary)
    source_x = max(0, -target_x)
    source_y = max(0, -target_y)
    destination_x = max(0, target_x)
    destination_y = max(0, target_y)
    copy_width = min(target_width - source_x, output.shape[1] - destination_x)
    copy_height = min(target_height - source_y, output.shape[0] - destination_y)
    if copy_width > 0 and copy_height > 0:
        output[
            destination_y:destination_y + copy_height,
            destination_x:destination_x + copy_width,
        ] = scaled[source_y:source_y + copy_height, source_x:source_x + copy_width]
    expand_px = max(0, int(round(expand_px)))
    if expand_px > 0:
        kernel = cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE,
            (expand_px * 2 + 1, expand_px * 2 + 1),
        )
        output = cv2.dilate(output, kernel, iterations=1)
    return output


def build_parsed_lower_face_mask(mask_image):
    """Expand the parsed under-nose region by 10 px, then feather inward 5 px."""
    if mask_image is None or mask_image.size == 0:
        return mask_image
    source_uses_bytes = mask_image.astype(np.float32).max(initial=0.0) > 1.0
    normalized = mask_image.astype(np.float32)
    if source_uses_bytes:
        normalized /= 255.0
    binary = (normalized >= 0.5).astype(np.uint8) * 255
    if np.any(binary):
        close_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, close_kernel)
        # Keep the upper edge at the parsed bottom-of-nose boundary while
        # adding the requested 10 px of support around cheeks, lips, and chin.
        first_row = int(np.flatnonzero(np.any(binary > 0, axis=1))[0])
        binary = expand_mask_region(binary, scale=1.0, expand_px=MOUTH_MASK_EXPAND_PX)
        binary[:first_row, :] = 0
    feathered = _inward_feather(binary, LOWER_FACE_FEATHER_PX)
    return np.round(feathered * 255.0).astype(np.uint8) if source_uses_bytes else feathered


def build_landmark_lower_face_mask(mask_image, face_box, crop_box, landmarks=None):
    """Blend a compact mouth region while keeping the nose and cheeks original."""
    if mask_image is None or mask_image.size == 0:
        return mask_image

    x, y, x1, y1 = [int(round(value)) for value in face_box]
    x_s, y_s, x_e, y_e = [int(round(value)) for value in crop_box]
    height, width = mask_image.shape[:2]
    face_width = max(1, x1 - x)
    face_height = max(1, y1 - y)
    feather_px = resolve_lower_face_feather_px(face_width, face_height)

    detail_mask = np.zeros((height, width), dtype=np.uint8)
    mouth_core = None
    landmark_array = np.asarray(landmarks if landmarks is not None else [], dtype=np.float32).reshape(-1, 2)
    valid_landmarks = landmark_array.shape[0] >= 17 and np.count_nonzero(landmark_array) > 0
    if valid_landmarks:
        local = landmark_array - np.array([x_s, y_s], dtype=np.float32)
        mouth = local[-24:] if local.shape[0] >= 24 else local
        mouth[:, 0] = np.clip(mouth[:, 0], 0, width - 1)
        mouth[:, 1] = np.clip(mouth[:, 1], 0, height - 1)

        mouth_hull = cv2.convexHull(np.round(mouth).astype(np.int32))
        mouth_core = np.zeros_like(detail_mask)
        cv2.fillConvexPoly(mouth_core, mouth_hull, 255)
        core_pad = max(3, int(round(min(face_width, face_height) * 0.035)))
        core_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (core_pad * 2 + 1, core_pad * 2 + 1))
        mouth_core = cv2.dilate(mouth_core, core_kernel, iterations=1)

        # Give lip motion enough room at the corners and below the mouth. The
        # hard upper cap prevents the expanded mask from reaching the nose.
        outer_pad_x = max(8, int(round(face_width * 0.10)))
        outer_pad_y = max(8, int(round(face_height * 0.09)))
        outer_kernel = cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE,
            (outer_pad_x * 2 + 1, outer_pad_y * 2 + 1),
        )
        detail_mask = cv2.dilate(mouth_core, outer_kernel, iterations=1)
        nose_safe_top = int(round(float(np.min(mouth[:, 1])) - min(10.0, face_height * 0.045)))
        detail_mask[:max(0, nose_safe_top), :] = 0
    else:
        center = (int(round((x + x1) * 0.5 - x_s)), int(round(y + face_height * 0.70 - y_s)))
        axes = (
            max(1, int(round(face_width * 0.29))),
            max(1, int(round(face_height * 0.13))),
        )
        cv2.ellipse(detail_mask, center, axes, 0, 0, 360, 255, -1)

        # Existing avatars do not persist landmarks. Intersecting their stored
        # mask with this compact mouth window upgrades them without retraining.
        normalized_source = mask_image.astype(np.float32)
        if normalized_source.max(initial=0.0) > 1.0:
            normalized_source /= 255.0
        source_support = (normalized_source > 0.02).astype(np.uint8) * 255
        if np.any(source_support):
            detail_mask = cv2.bitwise_and(detail_mask, source_support)

        nose_safe_top = int(round(y + face_height * 0.57 - y_s))
        detail_mask[:max(0, nose_safe_top), :] = 0
        mouth_core = np.zeros_like(detail_mask)
        core_axes = (
            max(1, int(round(face_width * 0.18))),
            max(1, int(round(face_height * 0.065))),
        )
        cv2.ellipse(mouth_core, center, core_axes, 0, 0, 360, 255, -1)
        mouth_core = cv2.bitwise_and(mouth_core, detail_mask)

    detail_mask = expand_mask_region(detail_mask)
    detail_mask[:max(0, nose_safe_top), :] = 0

    source_uses_bytes = mask_image.astype(np.float32).max(initial=0.0) > 1.0
    limited = _inward_feather(detail_mask, feather_px)
    if mouth_core is not None and np.any(mouth_core):
        # The generated mouth must remain fully opaque. Its transition is safe
        # because it sits inside the already feathered lower-face region.
        mouth_distance = cv2.distanceTransform((mouth_core > 0).astype(np.uint8), cv2.DIST_L2, 5)
        mouth_alpha = np.clip(mouth_distance / max(2.0, feather_px * 0.35), 0.0, 1.0)
        limited = np.maximum(limited, mouth_alpha.astype(np.float32))
    return np.round(limited * 255.0).astype(np.uint8) if source_uses_bytes else limited


def limit_blend_mask_to_lower_face(mask_image, face_box, crop_box):
    return build_landmark_lower_face_mask(mask_image, face_box, crop_box)


def get_image_blending(image,face,face_box,mask_array,crop_box,lip_color_state=None):
    body = image
    x, y, x1, y1 = face_box
    x_s, y_s, x_e, y_e = crop_box
    source_face = body[y:y1, x:x1].copy()
    face = match_generated_face_color(face, source_face, lip_color_state)
    face_large = body[y_s:y_e, x_s:x_e].copy()
    face_large[y-y_s:y1-y_s, x-x_s:x1-x_s]=face

    if mask_array.ndim == 2 and mask_array.dtype == np.float32:
        mask_image = mask_array
    else:
        mask_image = cv2.cvtColor(mask_array,cv2.COLOR_BGR2GRAY)
        mask_image = (mask_image/255).astype(np.float32)

    # mask_not = cv2.bitwise_not(mask_array)
    # prospect_tmp = cv2.bitwise_and(face_large, face_large, mask=mask_array)
    # background_img = body[y_s:y_e, x_s:x_e]
    # background_img = cv2.bitwise_and(background_img, background_img, mask=mask_not)
    # body[y_s:y_e, x_s:x_e] = prospect_tmp + background_img

    #print(mask_image.shape)
    #print(cv2.minMaxLoc(mask_image))

    body[y_s:y_e, x_s:x_e] = cv2.blendLinear(face_large,body[y_s:y_e, x_s:x_e],mask_image,1-mask_image)

    #body.paste(face_large, crop_box[:2], mask_image)
    return body


def get_image_blending_perspective(
    image,
    face,
    mask_array,
    alignment,
    lip_color_state=None,
    apply_color_match=True,
):
    """Composite an aligned MuseTalk frame through its per-frame inverse warp."""
    if image is None or face is None or alignment is None:
        return image
    height, width = image.shape[:2]
    source_to_aligned = np.asarray(alignment["source_to_aligned"], dtype=np.float32)
    aligned_to_source = np.asarray(alignment["aligned_to_source"], dtype=np.float32)
    face = face.astype(np.uint8, copy=False)

    if apply_color_match:
        aligned_source = cv2.warpPerspective(
            image,
            source_to_aligned,
            (face.shape[1], face.shape[0]),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_REPLICATE,
        )
        corrected_face = match_generated_face_color(face, aligned_source, lip_color_state)
    else:
        corrected_face = face

    # Preserve fine lip-edge contrast in the exact tracked lip contour only;
    # no enlargement is applied before perspective paste-back.
    corrected_face = enhance_lip_detail(
        corrected_face,
        build_mediapipe_lip_detail_mask(alignment, corrected_face.shape[1], corrected_face.shape[0]),
    )

    if mask_array.ndim == 2:
        mask = mask_array.astype(np.float32, copy=False)
    else:
        mask = cv2.cvtColor(mask_array, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
    if mask.shape[:2] != corrected_face.shape[:2]:
        mask = cv2.resize(mask, (corrected_face.shape[1], corrected_face.shape[0]), interpolation=cv2.INTER_LINEAR)
    mask = np.clip(mask, 0.0, 1.0)

    warped_face = cv2.warpPerspective(
        corrected_face,
        aligned_to_source,
        (width, height),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(0, 0, 0),
    )
    warped_mask = cv2.warpPerspective(
        mask,
        aligned_to_source,
        (width, height),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    alpha = np.clip(warped_mask, 0.0, 1.0)[..., None]
    blended = (
        warped_face.astype(np.float32) * alpha
        + image.astype(np.float32) * (1.0 - alpha)
    )
    return np.clip(blended, 0, 255).astype(np.uint8)

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


def build_landmark_lower_face_mask(mask_image, face_box, crop_box, landmarks=None):
    """Restrict paste-back to a compact, feathered mouth contour."""
    if mask_image is None or mask_image.size == 0:
        return mask_image

    x, y, x1, y1 = [int(round(value)) for value in face_box]
    x_s, y_s, x_e, y_e = [int(round(value)) for value in crop_box]
    height, width = mask_image.shape[:2]
    face_width = max(1, x1 - x)
    face_height = max(1, y1 - y)

    detail_mask = np.zeros((height, width), dtype=np.float32)
    landmark_array = np.asarray(landmarks if landmarks is not None else [], dtype=np.float32).reshape(-1, 2)
    valid_landmarks = landmark_array.shape[0] >= 17 and np.count_nonzero(landmark_array) > 0
    if valid_landmarks:
        local = landmark_array - np.array([x_s, y_s], dtype=np.float32)
        mouth = local[-24:] if local.shape[0] >= 24 else local
        mouth[:, 0] = np.clip(mouth[:, 0], 0, width - 1)
        mouth[:, 1] = np.clip(mouth[:, 1], 0, height - 1)
        hull = cv2.convexHull(np.round(mouth).astype(np.int32))
        cv2.fillConvexPoly(detail_mask, hull, 1.0)

        # Preserve enough room for open vowels while keeping cheeks, nose and
        # jaw from the source frame. An elliptical dilation follows the mouth
        # proportions and behaves better than a lower-face hull at side angles.
        mouth_width = max(1.0, float(np.ptp(mouth[:, 0])))
        mouth_height = max(1.0, float(np.ptp(mouth[:, 1])))
        pad_x = max(2, int(round(max(mouth_width * 0.14, face_width * 0.025))))
        pad_y = max(2, int(round(max(mouth_height * 0.50, face_height * 0.035))))
        kernel = cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE,
            (pad_x * 2 + 1, pad_y * 2 + 1),
        )
        detail_mask = cv2.dilate(detail_mask, kernel, iterations=1)
    else:
        center = (int(round((x + x1) * 0.5 - x_s)), int(round(y + face_height * 0.72 - y_s)))
        axes = (max(1, int(round(face_width * 0.28))), max(1, int(round(face_height * 0.12))))
        cv2.ellipse(detail_mask, center, axes, 0, 0, 360, 1.0, -1)

    sigma = max(1.25, min(face_width, face_height) * 0.018)
    detail_mask = cv2.GaussianBlur(detail_mask, (0, 0), sigmaX=sigma, sigmaY=sigma)

    normalized = mask_image.astype(np.float32)
    source_uses_bytes = normalized.max(initial=0.0) > 1.0
    if source_uses_bytes:
        normalized /= 255.0
    limited = np.clip(normalized * detail_mask, 0.0, 1.0)
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

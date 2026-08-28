import numpy as np
import cv2

def match_generated_face_color(face, source_face):
    """Reduce generated chroma drift while preserving source lighting."""
    if face is None or source_face is None or face.size == 0 or source_face.size == 0:
        return face

    height, width = face.shape[:2]
    if source_face.shape[:2] != (height, width):
        source_face = cv2.resize(source_face, (width, height), interpolation=cv2.INTER_LINEAR)

    generated_lab = cv2.cvtColor(face.astype(np.uint8), cv2.COLOR_BGR2LAB).astype(np.float32)
    source_lab = cv2.cvtColor(source_face.astype(np.uint8), cv2.COLOR_BGR2LAB).astype(np.float32)

    y_start = max(0, int(height * 0.42))
    x_start = max(0, int(width * 0.08))
    x_end = min(width, max(x_start + 1, int(width * 0.92)))
    generated_stats = generated_lab[y_start:, x_start:x_end]
    source_stats = source_lab[y_start:, x_start:x_end]
    valid = (
        (generated_stats[:, :, 0] > 18)
        & (generated_stats[:, :, 0] < 238)
        & (source_stats[:, :, 0] > 18)
        & (source_stats[:, :, 0] < 238)
    )
    if np.count_nonzero(valid) < 64:
        return face

    generated_ab = generated_stats[:, :, 1:3][valid]
    source_ab = source_stats[:, :, 1:3][valid]
    generated_center = np.median(generated_ab, axis=0)
    source_center = np.median(source_ab, axis=0)
    generated_spread = np.median(np.abs(generated_ab - generated_center), axis=0) + 1.0
    source_spread = np.median(np.abs(source_ab - source_center), axis=0) + 1.0

    # Never amplify source chroma. Correct only the color spread and offset that
    # the generated lower face added relative to its matching source frame.
    gain = np.clip(source_spread / generated_spread, 0.72, 1.0)
    original_ab = generated_lab[:, :, 1:3].copy()
    matched_ab = source_center + (original_ab - generated_center) * gain
    correction = np.clip(matched_ab - original_ab, -14.0, 14.0)

    generated_chroma = np.linalg.norm(original_ab - 128.0, axis=2)
    source_chroma = np.linalg.norm(source_lab[:, :, 1:3] - 128.0, axis=2)
    sigma = max(1.0, min(height, width) * 0.025)
    local_source_limit = cv2.GaussianBlur(source_chroma, (0, 0), sigmaX=sigma, sigmaY=sigma)
    chroma_limit = local_source_limit * 1.12 + 3.0
    corrected_ab = original_ab + correction * 0.78
    corrected_chroma = np.linalg.norm(corrected_ab - 128.0, axis=2)
    chroma_scale = np.minimum(1.0, chroma_limit / np.maximum(corrected_chroma, 1.0))
    corrected_ab = 128.0 + (corrected_ab - 128.0) * chroma_scale[:, :, None]

    generated_lab[:, :, 1:3] = np.clip(corrected_ab, 0, 255)
    return cv2.cvtColor(generated_lab.astype(np.uint8), cv2.COLOR_LAB2BGR)


def get_image_blending(image,face,face_box,mask_array,crop_box):
    body = image
    x, y, x1, y1 = face_box
    x_s, y_s, x_e, y_e = crop_box
    source_face = body[y:y1, x:x1].copy()
    face = match_generated_face_color(face, source_face)
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

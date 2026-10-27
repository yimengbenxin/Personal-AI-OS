"""Geometric projection registration only. No person/face/emotion model or generic caption path."""
import base64
import json
import sys

import cv2
import numpy as np


def decode(data):
    image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None or max(image.shape[:2]) > 4096:
        raise ValueError('MEETING_IMAGE_INVALID')
    return image


def projected_pointer(frame, slide):
    height, width = slide.shape[:2]
    detector = cv2.ORB_create(nfeatures=1800)
    a, da = detector.detectAndCompute(slide, None)
    b, db = detector.detectAndCompute(frame, None)
    if da is None or db is None:
        raise ValueError('MEETING_PROJECTION_UNAVAILABLE')
    pairs = cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(da, db, k=2)
    matches = [pair[0] for pair in pairs if len(pair) == 2 and pair[0].distance < .65 * pair[1].distance]
    if len(matches) < 15:
        raise ValueError('MEETING_PROJECTION_UNAVAILABLE')
    source = np.float32([a[m.queryIdx].pt for m in matches])
    destination = np.float32([b[m.trainIdx].pt for m in matches])
    transform, inliers = cv2.findHomography(source, destination, cv2.RANSAC, 2.5)
    if transform is None or inliers.mean() < .65:
        raise ValueError('MEETING_PROJECTION_UNAVAILABLE')
    corners = cv2.perspectiveTransform(np.float32([[[0, 0], [width-1, 0], [width-1, height-1], [0, height-1]]]), transform)[0]
    if not cv2.isContourConvex(corners) or np.any(corners < 0) or np.any(corners[:, 0] >= frame.shape[1]) or np.any(corners[:, 1] >= frame.shape[0]):
        raise ValueError('MEETING_PROJECTION_UNAVAILABLE')
    warped = cv2.warpPerspective(frame, np.linalg.inv(transform), (width, height))
    # Remove all non-slide pixels except one narrow pointer entering from a slide edge.
    # Wide/ambiguous occlusion is unavailable, never sent to vision for a generic description.
    delta = np.mean(np.abs(warped.astype(float)-slide.astype(float)), axis=2)
    threshold = max(40, float(np.median(delta)) + 4 * float(np.median(np.abs(delta-np.median(delta)))))
    mask = np.uint8(delta > threshold) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask)
    kept = np.zeros_like(mask)
    pointers = 0
    for label in range(1, count):
        x, y, w, h, area = stats[label]
        if area < width*height*.001:
            continue
        edge = x <= 2 or y <= 2 or x+w >= width-2 or y+h >= height-2
        narrow = w >= 3*h and h <= height*.08 or h >= 3*w and w <= width*.08
        if not edge or not narrow or area > width*height*.06:
            raise ValueError('MEETING_OCCLUSION_UNAVAILABLE')
        kept[labels == label] = 255
        pointers += 1
    if pointers != 1:
        raise ValueError('MEETING_POINTER_UNAVAILABLE')
    safe = slide.copy()
    safe[kept != 0] = warped[kept != 0]
    return safe


def contact_sheet(slide_bytes, frame_bytes):
    if not 1 <= len(frame_bytes) <= 3:
        raise ValueError('MEETING_FRAME_BATCH_INVALID')
    slide = decode(slide_bytes)
    panels = [projected_pointer(decode(frame), slide) for frame in frame_bytes] + [slide]
    width = 640
    height = round(width * slide.shape[0]/slide.shape[1])
    if height > 640:
        raise ValueError('MEETING_SLIDE_ASPECT_INVALID')
    canvas = np.zeros((height+30, width*len(panels), 3), dtype=np.uint8)
    for index, panel in enumerate(panels):
        canvas[30:, index*width:(index+1)*width] = cv2.resize(panel, (width, height))
        label = 'M: Mac slide' if index == len(panels)-1 else chr(65+index)+': projection'
        cv2.putText(canvas, label, (index*width+10, 22), cv2.FONT_HERSHEY_SIMPLEX, .6, (255, 255, 255), 1)
    ok, jpeg = cv2.imencode('.jpg', canvas, [cv2.IMWRITE_JPEG_QUALITY, 85])
    if not ok or len(jpeg) > 5*1024*1024:
        raise ValueError('MEETING_CONTACT_SHEET_INVALID')
    return jpeg.tobytes()


if __name__ == '__main__':
    args = json.loads(sys.stdin.buffer.read(13*1024*1024))
    result = contact_sheet(base64.b64decode(args['slide'], validate=True),
                           [base64.b64decode(frame, validate=True) for frame in args['frames']])
    sys.stdout.buffer.write(result)

"""Demo pixels only; execute geometric tests with the existing vision runtime, without any model/provider."""
import os
from pathlib import Path
import subprocess
import sys


def test_projection_privacy_and_unavailable_cases():
    result = subprocess.run([os.environ.get('PAIOS_VISION_PYTHON', sys.executable), str(Path(__file__)), 'fixtures'],
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr


if __name__ == '__main__':
    import importlib.util
    import cv2
    import numpy as np
    root = Path(__file__).parents[2]
    path = root / '01-product-half-finished/backend/services/personal-aios-integration/src/meeting/contact_sheet.py'
    spec = importlib.util.spec_from_file_location('meeting_projection', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    rng = np.random.default_rng(92)
    slide = rng.integers(60, 200, (360, 640, 3), dtype=np.uint8)
    frame = np.zeros((480, 800, 3), np.uint8)
    frame[:] = (0, 0, 255)  # A colored, private region outside the projection must never reach vision.
    frame[50:410, 80:720] = slide
    frame[220:230, 80:240] = (10, 10, 10)  # narrow pointer enters the left edge
    def jpeg(image):
        return cv2.imencode('.jpg', image, [cv2.IMWRITE_JPEG_QUALITY, 98])[1].tobytes()
    safe = module.projected_pointer(frame, slide)
    assert safe.shape == slide.shape
    assert not np.any(np.all(safe == [0, 0, 255], axis=2))
    assert module.contact_sheet(jpeg(slide), [jpeg(frame)]).startswith(b'\xff\xd8')
    broad = frame.copy()
    broad[160:310, 80:320] = (10, 10, 10)
    try:
        module.projected_pointer(broad, slide)
    except ValueError:
        pass
    else:
        raise AssertionError('A broad occluder must never be sent to the model')
    for bad in [b'bad jpeg', jpeg(np.zeros((360, 640, 3), np.uint8))]:
        try:
            module.contact_sheet(bad, [jpeg(frame)])
        except ValueError:
            pass
        else:
            raise AssertionError('Missing registration must be unavailable')

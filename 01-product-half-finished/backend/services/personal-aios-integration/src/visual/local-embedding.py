"""Pinned offline CLIP CPU process. JSON lines; one request executes at a time."""
import os
os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1', TOKENIZERS_PARALLELISM='false')
import sys
import json
import hashlib
import pathlib
import base64
import io


def reply(value):
    print(json.dumps(value, allow_nan=False), flush=True)


def error_code(error):
    if isinstance(error, ModuleNotFoundError):
        return 'LOCAL_EMBEDDING_DEPENDENCY_MISSING'
    code = str(error)
    return code if code.startswith('LOCAL_EMBEDDING_') and code.replace('_', '').isalpha() else 'LOCAL_EMBEDDING_RUNTIME_FAILED'


try:
    settings = json.loads(sys.stdin.readline())
    if sys.version_info < (3, 11):
        raise ValueError('LOCAL_EMBEDDING_PYTHON_VERSION_UNSUPPORTED')
    root = pathlib.Path(settings['model_directory'])
    if root.is_symlink():
        raise ValueError('LOCAL_EMBEDDING_ARTIFACT_UNSAFE')
    root = root.resolve(strict=True)
    expected = {item['path']: item['sha256'] for item in settings['artifacts']}
    actual = set()
    for path in root.rglob('*'):
        if path.is_symlink():
            raise ValueError('LOCAL_EMBEDDING_ARTIFACT_UNSAFE')
        if path.is_file():
            name = path.relative_to(root).as_posix()
            actual.add(name)
            with path.open('rb') as artifact:
                if name not in expected or hashlib.file_digest(artifact, 'sha256').hexdigest() != expected[name]:
                    raise ValueError('LOCAL_EMBEDDING_ARTIFACT_MISMATCH')
    if actual != set(expected) or not {'config.json', 'preprocessor_config.json', 'tokenizer_config.json', 'vocab.json', 'merges.txt'} <= actual:
        raise ValueError('LOCAL_EMBEDDING_ARTIFACT_MISSING')
    config = json.loads((root / 'config.json').read_text())
    if config.get('model_type') != 'clip' or config.get('projection_dim') != settings['dimensions'] or not config.get('vision_config') or not config.get('text_config'):
        raise ValueError('LOCAL_EMBEDDING_MULTIMODAL_REQUIRED')
    if not any(name.endswith('.safetensors') for name in actual):
        raise ValueError('LOCAL_EMBEDDING_SAFETENSORS_REQUIRED')
    import torch
    import transformers
    if transformers.__version__.split('.')[0] != '4' or torch.__version__.split('.')[0] != '2':
        raise ValueError('LOCAL_EMBEDDING_RUNTIME_VERSION_UNSUPPORTED')
    from PIL import Image
    from transformers import CLIPModel, CLIPProcessor
    torch.set_num_threads(settings['threads'])
    torch.set_num_interop_threads(1)
    Image.MAX_IMAGE_PIXELS = 4194304
    model = CLIPModel.from_pretrained(str(root), local_files_only=True, trust_remote_code=False, use_safetensors=True).to('cpu').eval()
    processor = CLIPProcessor.from_pretrained(str(root), local_files_only=True, trust_remote_code=False)
    reply({'ready': True})
    for line in sys.stdin:
        try:
            request = json.loads(line)
            with torch.inference_mode():
                if request['op'] == 'image':
                    image = Image.open(io.BytesIO(base64.b64decode(request['value'], validate=True)))
                    if max(image.size) > 4096 or image.width * image.height > 4194304:
                        raise ValueError('LOCAL_EMBEDDING_IMAGE_TOO_LARGE')
                    inputs = processor(images=image.convert('RGB'), return_tensors='pt')
                    vector = model.get_image_features(**inputs)
                elif request['op'] == 'query':
                    inputs = processor(text=[request['value']], return_tensors='pt', padding=True, truncation=True, max_length=model.config.text_config.max_position_embeddings)
                    vector = model.get_text_features(**inputs)
                else:
                    raise ValueError('LOCAL_EMBEDDING_OPERATION_INVALID')
                vector = vector[0].float()
                if vector.numel() != settings['dimensions'] or not torch.isfinite(vector).all() or vector.norm().item() == 0:
                    raise ValueError('LOCAL_EMBEDDING_VECTOR_INVALID')
                reply({'vector': (vector / vector.norm()).tolist()})
        except Exception as error:
            reply({'error': error_code(error)})
except Exception as error:
    reply({'error': error_code(error)})
    sys.exit(1)

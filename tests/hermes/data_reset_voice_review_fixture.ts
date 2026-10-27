/** Exercise the real registry producer over synthetic local storage, without authentication inputs. */
import {VoiceprintRegistry} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/voiceprint/registry.ts';
import {PosixStorage} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/storage.ts';

const storage=new PosixStorage(process.argv[2]!),model={id:'synthetic',sha256:'a'.repeat(64),dim:16};
const registry=new VoiceprintRegistry(storage,model);
const embedding=new Float32Array(16);embedding[0]=1;
await registry.observeAssistant({voice:'system_tts',embedding,speech_ms:2500,at:'2026-10-27T00:00:00.000Z'});
await registry.close();await storage.close();

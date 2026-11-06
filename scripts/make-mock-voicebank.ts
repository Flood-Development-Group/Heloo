// Writes the stand-in DiffSinger voicebank used by the e2e test. Run: npx vite-node scripts/make-mock-voicebank.ts <out.zip>
import { writeFileSync } from 'node:fs';
import { buildMockVoicebankZip } from '../tests/fixtures/mock-voicebank';

const out = process.argv[2] ?? 'e2e/out/MockSinger.zip';
writeFileSync(out, buildMockVoicebankZip());
console.log('wrote', out);

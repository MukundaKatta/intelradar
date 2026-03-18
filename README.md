# intelradar

**AI-powered competitive intelligence platform**

![Build](https://img.shields.io/badge/build-passing-brightgreen) ![License](https://img.shields.io/badge/license-proprietary-red)

## Install
```bash
npm install
```

## Quick Start
```typescript
import { Intelradar } from "./intelradar";
const instance = new Intelradar()
const r = await instance.process({ input: 'test' })
```

## CLI
```bash
npx tsx src/cli.ts status
npx tsx src/cli.ts run --input "data"
```

## API
| Method | Description |
|--------|-------------|
| `process()` | Process |
| `analyze()` | Analyze |
| `transform()` | Transform |
| `validate()` | Validate |
| `export()` | Export |
| `get_stats()` | Get stats |

## Test
```bash
npx vitest
```

## License
(c) 2026 Officethree Technologies. All Rights Reserved.

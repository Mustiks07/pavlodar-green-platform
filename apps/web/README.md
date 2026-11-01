# apps/web — клиент платформы озеленения (WP-02)

React 19 + TypeScript strict + Vite, TanStack Query, Zustand, React Router, MapLibre 5.20.0.
Дизайн-система — `packages/ui`, сгенерированный клиент — `packages/api-client`.
Корневой workspace/lockfile принадлежит WP-00 (GPT); этот пакет имеет свой lockfile.

```
npm ci
cp .env.example .env.local        # PG_API_ORIGIN — API foundation (по умолчанию :8001)
npm run dev                       # http://localhost:5173, /v1 /auth /health /openapi.json проксируются
npm run typecheck && npm test && npm run build
npm run check:api                 # сгенерированный клиент совпадает с contracts/openapi.json
node scripts/check-contrast.mjs   # контраст токенов WCAG AA
npm run evidence                  # скриншоты 4 размеров + проверки клавиатуры → docs/evidence/wp02
PG_TEST_CREDENTIALS=<ignored local test-credentials.json> node scripts/integration-check.mjs
```

Открывать в браузере `localhost`, не `127.0.0.1` (allowlist Origin/OIDC callback).
`/dev/ui` — каталог компонентов и состояний; только dev-сборка, данные — contracts/fixtures
и типизированные тестовые fixtures с меткой SYNTHETIC. В production-сборку не попадают.

Правила: браузер не считает сметы, вероятности, приоритеты и экоэффекты; null не равен 0;
неподдерживаемая сервером операция определяется по `/openapi.json` и объясняется пользователю.

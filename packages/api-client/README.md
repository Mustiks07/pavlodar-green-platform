# @pg/api-client

Generated from `contracts/openapi.json` (contract 1.0.0). Do not edit `src/generated/` by hand.

```
cd apps/web
npm run gen:api     # regenerate src/generated/schema.ts
npm run check:api   # fails if the committed file differs from a fresh generation
```

`src/types.ts` only aliases generated schemas. `src/transport.ts` adds same-origin
cookies, CSRF header on mutating requests, per-request timeout and maps
`application/problem+json` to typed `ApiError` categories (TZ §23).

Pre-freeze: generated from the baseline before WP-00 contract freeze. Regenerate after freeze.

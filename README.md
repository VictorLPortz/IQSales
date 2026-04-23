# IQSales – Forsikringssammenligner

## Sådan deployer du på Vercel

### Trin 1 — Upload til GitHub
1. Gå til github.com og opret en konto (gratis)
2. Klik "New repository", kald det `iqsales`, sæt det til Private
3. Upload alle filerne fra denne mappe

### Trin 2 — Deploy på Vercel
1. Gå til vercel.com og opret en konto med din GitHub-konto
2. Klik "Add New Project"
3. Vælg dit `iqsales` repository
4. Klik "Deploy" — Vercel finder selv strukturen

### Trin 3 — Tilføj API-nøgle
1. Gå til dit projekt på Vercel → Settings → Environment Variables
2. Tilføj en variabel:
   - Name: `ANTHROPIC_API_KEY`
   - Value: din Anthropic API-nøgle (sk-ant-...)
3. Klik Save og gå til Deployments → Redeploy

### Trin 4 — Del linket
Dit link ser sådan ud: `https://iqsales.vercel.app`
Del det med sælgerne — de kan bruge det med det samme, ingen installation.

## Filer
- `public/index.html` — selve applikationen
- `api/analyze.js` — backend der kalder Anthropic API sikkert
- `vercel.json` — Vercel konfiguration

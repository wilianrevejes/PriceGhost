---
name: importar-price-tracker
description: Importa o catálogo e o histórico de preços do projeto price-tracker (~/dev/price-tracker) para o banco do PriceGhost, sem alterar nada no price-tracker. Use quando o usuário pedir para trazer/sincronizar os produtos do price-tracker, popular o PriceGhost com o que ele já rastreia, ou recarregar o histórico de preços.
---

# Importar o price-tracker para o PriceGhost

O `~/dev/price-tracker` é a fonte de dados: ~550 itens com loja, preço e URL, e histórico real
em 23 rodadas de coleta no git log de `build/data.json`. O PriceGhost é quem automatiza.

## 0. Regra que não se negocia

**Nada é escrito no price-tracker.** O script só lê arquivo e roda `git -C <dir> show` / `git log`.
Se você se vir precisando de `checkout`, `stash`, `fetch`, `pull` ou `commit` lá, parou: está
errado. Confira depois com `git -C ~/dev/price-tracker status --porcelain` — tem que sair vazio.

## 1. Dry run, sempre antes

```bash
cd backend
npx tsx scripts/import-price-tracker.ts
```

Sai sem tocar o banco e mostra: itens por arquivo, produtos distintos, hosts, quantos entram
pausados. Confira que o número de produtos distintos faz sentido (~550) e que os quatro hosts
principais (amazon.com.br, kabum, pichau, terabyteshop) somam a maior parte. Se `data.json` vier com
0 itens, o price-tracker mudou de forma — investigue antes de gravar.

## 2. Pré-requisito: migrations e usuário

O script precisa das migrations do `backend/src/index.ts` já rodadas, e de pelo menos um usuário.
Se nunca subiu:

```bash
DISABLE_SCHEDULER=true DATABASE_URL=... JWT_SECRET=dev npm run dev
# loga "Database migrations completed" e "Price check scheduler disabled"
# registre um usuário na UI ou via POST /api/auth/register
```

**Suba com `DISABLE_SCHEDULER=true` para migrar e importar.** Sem isso, qualquer produto já vencido
entra na fila de scrape na hora. O import grava `refresh_interval = 86400` (um check por dia) e
distribui o primeiro check ao longo das próximas 24h, então quando você subir o scheduler de
verdade a coleta vem espalhada, ~1 produto a cada 2 min, não em rajada.

## 3. Gravar

```bash
npx tsx scripts/import-price-tracker.ts --write --history
```

`--history` é o que vale a pena: sem ele cada produto começa com um ponto só. Com ele, o git log do
`build/data.json` reconstrói a série real (medido: 23 rodadas → ~1.800 pontos que casam com produto
atual, de jul/2026 a nov/2026).

Opções: `--from <dir>` (ou `PRICE_TRACKER_DIR`), `--user <email>` se houver mais de um usuário.

Rodar de novo é seguro: produto é `ON CONFLICT (user_id, url) DO UPDATE` e ponto de preço só entra
se não existir um na mesma data.

## 4. Conferir

```sql
SELECT p.name, count(h.id) AS pts, min(h.price), max(h.price),
       to_char(min(h.recorded_at),'YYYY-MM-DD') AS primeiro
FROM products p JOIN price_history h ON h.product_id = p.id
GROUP BY p.id, p.name ORDER BY pts DESC LIMIT 10;
```

Esperado: os tiers de GPU e os X3D com ~20 pontos cada, moeda `BRL`, série começando em jul/2026.
Se a moeda sair `USD`, o `priceParser` regrediu — ver `docs/LOJAS-BR.md` §1.

## 5. O que NÃO vem

- Host editorial (TechSpot, Tweakers, KitGuru, YouTube, hardwarebarato, apple.com) é descartado:
  link real, mas não é preço a rastrear.
- Facebook Marketplace, Magazine Luiza e Shopee entram **pausados** — sem caminho de scrape hoje
  (`docs/LOJAS-BR.md`). Entram para o catálogo não perder linha, não para serem coletados.
- As abas de *análise* do price-tracker (combos, IA x Jogo, Custo 3 anos, veredito de momento de
  compra) não têm equivalente aqui e **não** são importadas. Isso é cálculo do artefato dele, não
  dado de produto — se o Wilian quiser isso no PriceGhost, é feature nova, não import.

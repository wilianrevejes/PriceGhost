# CLAUDE.md — PriceGhost (fork do Wilian)

Fork de [`clucraft/PriceGhost`](https://github.com/clucraft/PriceGhost) em
`wilianrevejes/PriceGhost`. Rastreador de preços self-hosted: Node/Express/TypeScript + React/Vite +
PostgreSQL, com scraping multi-estratégia e votação de preço.

Ler junto: `README.md` (upstream, uso geral) e **`docs/LOJAS-BR.md`** (lojas brasileiras — o que
foi medido, o que quebra e por quê). Idioma das respostas: português (BR), conciso e direto.

## Por que este fork existe

O upstream é afinado para loja americana/europeia. O que esse fork adiciona é **suporte a loja
brasileira**, e a motivação é juntar os dois projetos de preço do Wilian:

- **`~/dev/price-tracker`** — pipeline Python + artefato HTML/XLSX estático, coleta manual por
  skill, ~550 itens rastreados em 53 lojas BR, histórico real em 23 rodadas no git. **Não mexer
  nele.** É fonte de dados, só leitura.
- **este repo** — app com banco, scheduler, notificação (Telegram/Discord/ntfy/Gotify/Pushover),
  gráfico de histórico, PWA, multiusuário.

A ponte é `backend/scripts/import-price-tracker.ts`. O price-tracker traz o *catálogo e o
histórico*; o PriceGhost traz a *automação e o alerta*.

## Arquitetura do scraping (o que você precisa saber antes de mexer)

Quatro extratores votam num preço (`scrapeProductWithVoting`):

| método | confiança | de onde vem |
|---|---|---|
| `json-ld` | 0.9 | `<script type="application/ld+json">` |
| `site-specific` | 0.85, **0.95 em loja BR** | `siteScrapers` em `services/scraper.ts` + `services/scrapers-br.ts` |
| `generic-css` | 0.6 | `genericPriceSelectors`, no máximo 3 candidatos |
| `ai` | varia | `services/ai-extractor.ts`, opcional |

`findPriceConsensus` agrupa candidatos que caem dentro de 5% e **deixa o maior grupo ganhar** —
contagem de voto vem antes de confiança. Essa é a regra que mais pega de surpresa: três preços de
produto não relacionado derrotam um JSON-LD correto. Duas consequências já tratadas, não desfazer
sem ler `docs/LOJAS-BR.md`:

1. `generic-css` é limitado a 3 candidatos **dentro** do `.each()` (`MAX_GENERIC_CANDIDATES`).
   Sem isso, o carrossel de recomendados de uma loja BR entra com 35.
2. Scraper BR devolve **um preço só**, o à vista. Devolver também o do cartão fazia esse valor
   aparecer duas vezes (aqui + JSON-LD) e ganhar por voto.

## Lojas BR — regras que não mudam

Detalhe e evidência em `docs/LOJAS-BR.md`. O essencial:

- **Preço = à vista / PIX.** Loja BR anuncia dois preços; o do cartão é mais alto e o JSON-LD da
  Pichau e do OLX traz justamente o errado. O scraper BR mira o à vista.
- **Amazon .com.br e Mercado Livre exigem perfil logado de verdade.** Perfil stealth limpo toma
  muro de bot (Amazon devolve **200** com página de bloqueio — nenhum fallback por status code
  pega isso). Setar:
  ```bash
  export PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
  export PUPPETEER_USER_DATA_DIR=/home/wradmin/.config/chromium-wsl
  ```
  Esse perfil tem **contas reais do Wilian** (ver `~/.claude/CLAUDE.md`). Só leitura de página de
  produto — nunca postar, comentar, mandar mensagem ou comprar. E **um Chrome por perfil**: se o
  `chrome-wsl` dele estiver aberto, o scraper não sobe.
- **Terabyte, Pichau, OLX, Shopee** passam só por browser (Cloudflare) — já estão em
  `BR_BROWSER_SITES`, que `scrapeProduct` consulta antes de tentar HTTP.
- **Kabum** funciona em HTTP puro, pelo `__NEXT_DATA__`. Nunca ler `installment.amount`: é o valor
  da parcela (R$ 176,20 num produto de R$ 1.762,00).
- **Shopee** está sem caminho hoje (payload anti-bot + captcha), e **Magazine Luiza** também (403
  nos três caminhos). Produto dessas lojas é importado **pausado**, não descartado.
- Classe hasheada por build (Pichau) e classe que muda por breakpoint (OLX) são normais. Case no
  sufixo semântico com `[class*=]` e use `firstPrice()`, que pula o rótulo e pega o número.
- **Loja BR sem scraper próprio** cai no genérico, e são 47 dos 53 hosts do catálogo. `pageLocale($,
  url)` dá a dica de locale (`.com.br` ou `<html lang=pt>` → vírgula decimal, BRL) para os
  extratores genéricos e para o JSON-LD; candidato `site-specific` marcado USD em página `.com.br` é
  corrigido para BRL.
- **404 de loja BR não é página vazia**: a da Pichau traz carrossel de recomendados com preço.
  `brPageNotFound($)` olha o `<title>` e a votação para antes de coletar candidato — URL morta
  devolve "sem preço", nunca o preço de um produto vizinho.
- **Um Chrome por perfil.** Se o `chrome-wsl` dele estiver aberto, lançar outro aborta no
  `SingletonLock`. Setar `PUPPETEER_CDP_URL=http://127.0.0.1:9222` (`chrome-wsl --cdp`) e o scraper
  dirige o que já está rodando — mesma sessão logada, fecha só a própria aba.

## Parser de preço

`backend/src/utils/priceParser.ts`. O padrão `R$` vem **antes** do `[$€£¥₹]`, porque `R$` contém
`$` — era por isso que `R$ 1.625,45` virava `1.63 USD`.

`normalizePrice(str, hint)` resolve separador assim: se tem ponto e vírgula, **o último é o
decimal**; só vírgula → `,\d{1,2}$` é decimal; só ponto → **3 dígitos** depois do último ponto (ou
mais de um ponto) é milhar, e só isso (`R$ 7.700` = 7700 e `2376.00` = 2376, em qualquer locale).

O padrão de número puro tem duas alternativas de propósito: uma exige separador de milhar de
verdade, a outra aceita número sem separador (`2376.00`). Uma só, com separador opcional e grupo de
3, casava apenas `237` em `2376.00` — qualquer preço acima de 999 escrito sem separador, como em
`content=` e `data-price`, era truncado.

`parsePrice(text, hint, fallbackCurrency)`: o terceiro argumento é a moeda quando o texto não traz
nenhuma — era `USD` fixo, o que rotulava loja BR como dólar. Quem chama passa
`pageLocale($, url).currency`.

Ao mexer aqui, rodar os dois lados — en-US (`$1,234.56`), pt-BR (`R$ 1.234,56`), CHF
(`CHF 1'234.56`) e número cru (`2376.00`).

## Importar do price-tracker

```bash
cd backend
npx tsx scripts/import-price-tracker.ts                        # dry run, sempre primeiro
npx tsx scripts/import-price-tracker.ts --write --history
```

- **Read-only no price-tracker**: só lê arquivo e roda `git -C <dir> show/log`. Nunca checkout,
  stash, fetch ou commit lá.
- Extrai por **campo**, não por caminho no JSON (`{url, preco, loja, produto|modelo|nome}`), então
  aba nova do price-tracker entra de graça.
- `--history` caminha o git log de `build/data.json`: cada commit é uma rodada de coleta. Último
  commit do dia ganha (mesma regra do `build/historico_git.py` de lá).
- Precisa do backend ter subido uma vez, para as migrations do `index.ts` terem rodado. O script
  checa e avisa.
- Host editorial (TechSpot, Tweakers, YouTube, hardwarebarato) é **descartado**; loja sem caminho
  de scrape é **importada pausada**.

## Rodar local

```bash
# banco (podman ou docker)
podman run -d --name pg-priceghost -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=priceghost -p 55432:5432 docker.io/library/postgres:16-alpine

cd backend && npm install
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/priceghost JWT_SECRET=dev npm run dev
cd ../frontend && npm install && npm run dev
```

## Cadência de coleta

**Um check por produto por dia.** `refresh_interval` default = **86400s**, nas três definições de
schema (`database/init.sql`, `backend/src/index.ts`, `backend/src/config/init-db.ts`), nas rotas e
no `ProductForm`. Banco que já existe recebe `ALTER COLUMN … SET DEFAULT 86400` nas migrations —
linha que já estava lá **não muda**, cada produto mantém o intervalo que recebeu.

O cron `* * * * *` é **poll, não coleta**: um tick só raspa quem tem `next_check_at` no passado.
É isso que espalha o catálogo em vez de coletar tudo de uma vez — por isso o import distribui o
primeiro check **uniformemente ao longo das 24h** (`firstCheckOffset`), ~1 produto a cada 2 min com
548 itens. Tick sem nada devido não loga nada.

⚠️ Antes de importar, suba o backend com **`DISABLE_SCHEDULER=true`** — ele migra e atende API sem
raspar. Sem isso, qualquer produto já vencido entra na fila na hora.

## Antes de entregar mudança no scraper

1. `npx tsc --noEmit` no `backend/`.
2. Testar **o pipeline inteiro** (`scrapeProductWithVoting`), não o seletor isolado — o que decide
   é qual candidato ganha a votação.
3. Testar as 6 lojas que funcionam (Kabum, Terabyte, Pichau, Amazon BR, Mercado Livre, OLX) com o
   perfil logado setado. Preço esperado é o **à vista**.
4. Mudou o parser? Rodar também um caso en-US e um CHF, para não consertar BR quebrando o upstream.

---
name: loja-br
description: Adiciona ou conserta o suporte a uma loja brasileira no scraper do PriceGhost (Kabum, Terabyte, Pichau, Amazon BR, Mercado Livre, OLX, Shopee, Magalu e outras). Use quando um produto BR vier sem preço, com preço errado, com moeda errada, ou quando o usuário pedir para suportar uma loja nova.
---

# Loja brasileira no scraper

Contexto medido e evidência em `docs/LOJAS-BR.md` — **ler antes**. Código em
`backend/src/services/scrapers-br.ts`.

## 0. Meça, não presuma

Loja brasileira mente de três formas diferentes, e cada uma pede um caminho distinto. Antes de
escrever seletor, descubra em qual você está:

```bash
# 1) HTTP puro
curl -sS --compressed -o /tmp/loja.html -w 'http=%{http_code} bytes=%{size_download}\n' -L \
  -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' \
  -H 'Accept-Language: pt-BR,pt;q=0.9' '<URL do produto>'
grep -o -i '<title>[^<]*</title>' /tmp/loja.html | head -1
```

- **403 + "Just a moment..."** → Cloudflare. Browser resolve. → `BR_BROWSER_SITES`
- **200 mas página de bloqueio** (Amazon: "To discuss automated access…") → nenhum fallback por
  status code pega. Precisa de perfil logado. → `BR_BROWSER_SITES` + `BR_LOGGED_PROFILE_SITES`
- **200 com HTML normal** → dá em HTTP puro, como a Kabum.
- **200, HTML grande, zero `R$`** → casca JS. O preço vem de XHR; precisa capturar a resposta.

Depois teste com perfil logado antes de declarar impossível:

```bash
export PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
export PUPPETEER_USER_DATA_DIR=/home/wradmin/.config/chromium-wsl
```

Se o Chrome dele já estiver aberto nesse perfil, lançar outro aborta no `SingletonLock`. Em vez de
fechar o navegador dele, dirija o que está rodando:

```bash
export PUPPETEER_CDP_URL=http://127.0.0.1:9222   # chrome-wsl --cdp
```

Mercado Livre estava documentado como bloqueado no price-tracker (jul/2026) e **funciona** por esse
caminho. Vale retestar antes de desistir de qualquer loja.

## 1. Ache a fonte do preço, na ordem

1. `__NEXT_DATA__` ou outro `<script type="application/json">` — melhor opção, campo muda menos que classe.
2. JSON-LD `offers` — mas **confira contra o DOM**: na Pichau o JSON-LD é o preço do cartão, no OLX
   fica desatualizado depois de o vendedor editar o anúncio.
3. Elemento com classe semântica.
4. Texto solto — último recurso.

## 2. O preço é o à vista

Loja BR anuncia à vista (desconto PIX/boleto) e total no cartão. **O à vista é o preço.** Devolva
**um só** — não preencha `allPrices` com o do cartão: ele já chega ao modal pelo JSON-LD, e
duplicá-lo faz o valor errado ganhar por contagem de voto no `findPriceConsensus`.

Cuidado com o valor da **parcela** (R$ 176,20 num produto de R$ 1.762,00). O parser já rejeita
texto com `10x de`, `sem juros`, `no cartão`, `parcelado`, `/mês` — mas se você ler um campo
numérico de JSON (tipo `installment.amount` da Kabum) o filtro não te protege.

## 3. Armadilhas de seletor já pagas

- **Classe hasheada por build** (Pichau: `mui-1jk88bq-price_vista-extraSpacePriceVista`) — case no
  sufixo semântico: `[class*="price_vista"]`.
- **Rótulo antes do valor** — `[class*="price_vista"]` casa primeiro com o texto "à vista" (classe
  `…price_vista_text…`). Use `firstPrice()`, que percorre os matches e devolve o primeiro que
  *parseia como preço*, em vez de `firstText()`.
- **Classe que muda por breakpoint** (OLX: `.typo-display-large` em 800px,
  `.typo-title-large` em 1920px). Liste as duas.
- **Preço que renderiza tarde**, depois de outros `R$` já estarem na página (OLX) — registre em
  `BR_WAIT_SELECTORS` em vez de aumentar espera genérica.
- **Página 404 com carrossel** (Pichau) — a votação já para em `brPageNotFound($)`, pelo `<title>`.
  Se a loja nova sinaliza 404 de outro jeito (só no corpo, ou com 200 e redirect para busca),
  acrescente a detecção **antes** de confiar em qualquer seletor: 404 lido como produto escreve
  preço de vizinho no histórico.
- **Loja sem scraper próprio** cai no genérico, e é a maioria do catálogo. Ali o que decide moeda e
  separador é `pageLocale($, url)`; se vier moeda errada numa loja nova, o host provavelmente não é
  `.com.br` **e** a página não declara `lang="pt-BR"`.
- **Carrossel de recomendados**: nunca procure preço no documento inteiro. `brGenericStorefront`
  usa `productScope($)` (ancora no `h1`, sobe até o ancestral que tem `R$`). Classe de preço é
  reaproveitada em todo card, e o carrossel costuma vir antes do produto no DOM.
- **`15% de desconto no PIX` parseia como 15.** `firstPrice()` pula texto com `%` sem `R$`.

## 4. Registre a loja

Em `scrapers-br.ts`:

| lista | quando |
|---|---|
| `brSiteScrapers` | sempre (o scraper em si) |
| `BR_BROWSER_SITES` | HTTP puro não serve |
| `BR_LOGGED_PROFILE_SITES` | perfil stealth limpo toma muro |
| `BR_WAIT_SELECTORS` | preço renderiza tarde |
| `BR_UNSUPPORTED_SITES` | nenhum caminho funciona — **com a razão por escrito** |

Os scrapers BR ficam **no começo** do array `siteScrapers`: o matcher da Amazon upstream
(`/amazon\.(com|…)/`) também casa com `amazon.com.br`.

## 5. Teste o pipeline, não o seletor

Seletor certo com votação errada = preço errado. Rode `scrapeProductWithVoting` e olhe **qual
candidato ganhou**:

```ts
const r = await scrapeProductWithVoting(url, undefined, undefined, undefined, true, true);
console.log(r.price, r.selectedMethod, r.needsReview,
            r.priceCandidates.map(c => `${c.price}(${c.method})`).join(' '));
```

Esperado numa loja BR: `selectedMethod === 'site-specific'` e o valor igual ao à vista anunciado.
Rode as 6 que funcionam antes de entregar, e `npx tsc --noEmit`.

## 6. Atualize `docs/LOJAS-BR.md`

A matriz de acesso lá vale porque cada linha tem teste atrás. Loja nova ou comportamento que mudou
→ nova linha com a data da medição. Não escreva lá o que você não mediu.

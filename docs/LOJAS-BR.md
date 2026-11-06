# Lojas brasileiras no PriceGhost

Tudo aqui foi **medido em 06/11/2026** contra páginas de produto reais, não inferido. Cada linha da
matriz abaixo tem um teste por trás. O código vive em
[`backend/src/services/scrapers-br.ts`](../backend/src/services/scrapers-br.ts).

## Matriz de acesso

| Loja | HTTP puro (axios) | Puppeteer stealth (perfil limpo) | Chrome logado do WSL | Fonte do preço |
|---|---|---|---|---|
| **Kabum** | ✅ 200 | ✅ | ✅ | `__NEXT_DATA__` → `product.prices.priceWithDiscount` |
| **Terabyte** | ❌ 403 Cloudflare | ✅ | ✅ | `#valVista` (PIX) — JSON-LD concorda |
| **Pichau** | ❌ 403 Cloudflare | ✅ | ✅ | `[class*="price_vista"]` (PIX) — **JSON-LD traz o cartão** |
| **Amazon .com.br** | ❌ muro de bot (200 com página de bloqueio) | ❌ mesmo muro | ✅ | `.a-offscreen` / corePrice |
| **Mercado Livre** | ❌ `/gz/account-verification` | ❌ redirect | ✅ | JSON-LD `offers` (BRL, availability) |
| **OLX** | ❌ 403 Cloudflare | ✅ | ✅ | `.typo-display-large` / `.typo-title-large` |
| **Shopee** | shell JS, zero preço | ❌ payload anti-bot | ❌ payload anti-bot | — (ver abaixo) |
| **Magazine Luiza** | ❌ 403 | ❌ 403 | ❌ 403 | — sem caminho |

Resultado do pipeline completo (`scrapeProductWithVoting`) depois dos ajustes — reconferido em
06/11/2026 com `PUPPETEER_CDP_URL`, em produtos que o price-tracker rastreia:

```
Kabum          BRL 1762      via site-specific
Terabyte       BRL 2599.99   via site-specific
Pichau         BRL  329.99   via site-specific   (JSON-LD dizia 388.22 — cartão)
Amazon BR      BRL 1625.45   via site-specific
Mercado Livre  BRL   72.90   via site-specific
OLX            BRL 1746      via site-specific   (JSON-LD dizia 1800 — desatualizado)
Ateliê do Som  BRL 2376      via generic-css     (loja sem scraper próprio, Loja Integrada)

Focus Eletron. BRL 2789.10   via site-specific   (JSON-LD dizia 3099 — cartão)
Ateliê do Som  BRL 1422      via site-specific   (kit AG03MK2)
Music Company  BRL 2554.44   via site-specific   (= JSON-LD)
Loja Shure     BRL 1099      via site-specific   (= JSON-LD)
UA Brasil      BRL 1899      via site-specific   (= JSON-LD)
```

O segundo bloco é o `brGenericStorefront`, a lista de ~37 lojas BR sem scraper próprio. Cada valor
confere com o que o price-tracker registra para o mesmo produto.

A última linha é o caso que o catálogo importado tem em maior número: loja BR **sem** scraper
próprio, lida pelo extrator genérico. Até os itens 5 e 6 abaixo serem consertados ela devolvia
`USD 237` para um produto de R$ 2.376,00.

## As oito coisas que quebram e por quê

### 1. `R$ 1.625,45` virava `1.63 USD`

O `priceParser.ts` original não conhecia real nenhum. Pior: o padrão `[$€£¥₹]` **casa com o `$` de
`R$`**, então ele reportava USD com confiança e o número saía destruído:

| entrada | antes | agora |
|---|---|---|
| `R$ 1.625,45` | `1.63 USD` | `1625.45 BRL` |
| `R$ 2.599,99` | `2.6 USD` | `2599.99 BRL` |
| `R$ 7.700` | `7.7 USD` | `7700 BRL` |
| `R$ 176,20` | `176.2 USD` | `176.2 BRL` |

O caso `R$ 7.700` (OLX omite centavos) merece atenção: ponto seguido de **exatamente 3 dígitos** é
separador de milhar em qualquer locale — nenhuma loja cobra sete reais e setenta. Essa regra entrou
no `normalizePrice` e vale para todas as moedas, não só BRL.

Também entrou filtro de parcelamento em pt-BR: `10x de R$ 176,20 sem juros`, `no cartão`,
`parcelado`, `/mês`. Sem isso, o valor da parcela (R$ 176,20 num produto de R$ 1.762,00) é um
candidato perfeitamente plausível.

### 2. Toda loja BR tem dois preços, e o JSON-LD escolhe o errado

Loja brasileira anuncia um preço **à vista** (com desconto PIX/boleto) e um total **no cartão**.
A convenção do price-tracker — e a daqui — é que **o preço é o à vista**.

As lojas não concordam sobre qual vai para o dado estruturado:

| Loja | JSON-LD | à vista no DOM |
|---|---|---|
| Terabyte | 2599.99 | 2599.99 ✅ igual |
| Pichau | 2082.34 | **1769.99** ← o certo |
| OLX | "7800" | **7700** ← o certo (anúncio editado) |

Por isso um candidato `site-specific` de loja BR vale **0.95** (`BR_SITE_CONFIDENCE`), acima do
0.9 do JSON-LD — o inverso da premissa upstream. E os scrapers BR devolvem **um preço só**, o à
vista: quando devolviam os dois, o valor do cartão aparecia duas vezes (aqui + JSON-LD) e o
`findPriceConsensus`, que deixa o maior grupo ganhar, elegia o errado por contagem de voto. O preço
do cartão continua chegando ao modal de seleção pelo extrator JSON-LD, sozinho.

### 3. O carrossel de "produtos recomendados" ganhava a votação

`genericPriceSelectors` inclui `[class*="price" i]`, que numa página de loja BR pega **todo cartão
do carrossel de recomendados** — 35 candidatos medidos numa única página. Três preços de produtos
não relacionados que caiam dentro de 5% um do outro formam um grupo de 3 e derrotam JSON-LD e
site-specific, que ficam em grupos de 1. Preço confiante e errado, de um produto que o dono nem
rastreia.

A guarda `candidates.length >= 3` existia, mas rodava **entre** seletores, depois do `.each()` já
ter empurrado tudo. Agora o corte é dentro do `.each()` (`MAX_GENERIC_CANDIDATES`).

### 4. OLX renomeia a classe do preço por breakpoint

Mesmo anúncio, mesmo navegador, só mudando o viewport:

| viewport | classe do preço principal |
|---|---|
| 800×600 | `.typo-display-large` |
| 1920×1080 | `.typo-title-large` |

O `scrapeWithBrowser` usa 1920×1080, então um seletor só nunca ia funcionar. As duas classes estão
na lista. A linha secundária (`.typo-body-medium`) ficou **de fora de propósito**: num anúncio com
redução de preço ela é o valor antigo, mais alto.

Além disso, o OLX só renderiza o preço **depois** do `networkidle2`, e depois de outros `R$` já
estarem na página — uma espera genérica por "qualquer R$" termina cedo demais. Daí
`BR_WAIT_SELECTORS`, que espera o elemento certo por loja.

E OLX **expira anúncio**: anúncio morto devolve 200 com título "Anúncio não encontrado". Isso é
reportado como `out_of_stock`, não como falha de scrape.

### 5. `<meta itemprop="price" content="2376.00">` virava R$ 237

O padrão de número puro do parser era
`\d{1,3}(?:[,.\s]?\d{3})*(?:[.,]\d{2})?`: separador de milhar **opcional**, mas grupo de
**exatamente 3 dígitos**. Em `2376.00` ele casa só `237` — os outros caracteres não formam grupo nem
decimal — e o produto de R$ 2.376,00 entra no histórico como R$ 237.

Vale para qualquer preço acima de 999 escrito **sem separador de milhar**, que é exatamente como
preço legível por máquina é escrito: `content=`, `data-price`, JSON. E em qualquer moeda — `1299.00`
virava `129`. Medido na Ateliê do Som (plataforma Loja Integrada), onde o único candidato da página
é esse `<meta>`.

O padrão agora tem duas alternativas: uma exige separador de verdade (`2.376,00`, `1,234.56`,
`1 234,56`), a outra aceita número sem separador (`2376.00`). E a regra de "ponto é milhar" voltou a
ser só **3 dígitos depois do último ponto** (ou mais de um ponto) — antes, em página com vírgula
decimal, qualquer cauda de 2 dígitos virava milhar, e aí `2376.00` dava 237600.

### 6. Loja BR também fala dólar quando ninguém pergunta

O extrator genérico chamava `parsePrice` sem dica de locale e com fallback `USD` fixo. Resultado:
**número certo, moeda errada**, em toda loja fora das seis com scraper próprio — e o catálogo
importado tem 53 hosts, 47 deles no genérico.

`pageLocale($, url)` (em `scrapers-br.ts`) decide pelo host (`.com.br`) ou pelo `<html lang>`, e
vira `{ hint: 'comma', currency: 'BRL' }`. A dica desce para `parsePrice` nos dois extratores
genéricos e no JSON-LD. `currencyFromText()` testa `R$` **antes** dos símbolos, mesma ordem do
parser. E candidato `site-specific` marcado `USD` em página `.com.br` é corrigido para BRL — é como
o scraper upstream da Amazon reportava um `USD 1711` ao lado do `BRL 1625,45` correto, na mesma
página.

### 7. Página 404 de loja BR devolve preço com confiança

URL de produto BR morre: Pichau e Kabum trocam slug. E 404 de loja **não é página vazia** — a da
Pichau vem com carrossel de recomendados, cada card com seu `price_vista`. Medido: a URL morta de um
processador de R$ 1.769,99 devolvia **R$ 249,99**, com confiança 0.95, de um produto recomendado.
Num coletor diário desatendido isso entra no histórico como se fosse queda de preço.

`brPageNotFound($)` checa o `<title>` (`404`, `página não encontrada`, `produto não encontrado`), e
`scrapeProductWithVoting` para antes de coletar candidato nenhum. Anúncio expirado de OLX é outro
caso: ele redireciona para a busca, com título normal, e lá o scraper já não acha preço — devolve
`out_of_stock`, não preço de card alheio.

### 8. O carrossel de novo, agora dentro do scraper de loja genérica

`brGenericStorefront` procurava o preço à vista com `.product-price .price` e companhia **no
documento inteiro**. Loja BR reaproveita essas classes em todo card de "quem viu também viu", e o
carrossel costuma vir **antes** do produto no DOM. Medido na Focus Eletrônicos: três produtos
diferentes recebendo o mesmo **R$ 5.391,00** — preço de um quarto produto — com confiança 0.95, a
mais alta do sistema. O item 3 tratou disso no `generic-css`; aqui era o mesmo erro um nível acima,
e pior, porque confiança alta não vai a revisão.

`productScope($)` ancora no `<h1>`: sobe do título até o primeiro ancestral que também contém um
`R$` e trata esse bloco como o produto. Sem `h1` ou sem preço por perto, cai para `<body>` e aí
**só** os seletores de à vista/PIX valem, nunca os largos.

Com escopo, os cinco casos medidos acertam o que o price-tracker registra (bloco acima). Também
entrou um detalhe: `15% de desconto no PIX` mora num elemento de preço e parseia como **15** —
`firstPrice()` agora pula texto com `%` que não tenha `R$`.

## Perfil logado do Chrome (obrigatório p/ Amazon BR e Mercado Livre)

Amazon .com.br e Mercado Livre recusam perfil stealth limpo e atendem navegador com perfil real
logado. Neste WSL esse perfil já existe (`~/.config/chromium-wsl`, ver `~/.claude/CLAUDE.md`):

```bash
export PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
export PUPPETEER_USER_DATA_DIR=/home/wradmin/.config/chromium-wsl
```

Sem `PUPPETEER_USER_DATA_DIR` o scraper **avisa no log** antes de bater no muro, em vez de falhar
calado.

> ⚠️ **Um Chrome por perfil.** O diretório de perfil não pode ser usado por dois Chromes ao mesmo
> tempo — o segundo aborta com `Failed to create SingletonLock: File exists`. Se o Wilian estiver
> com o `chrome-wsl` aberto, o scraper não sobe.
>
> Saída melhor que copiar o perfil: **dirigir o Chrome que já está rodando**.
> `chrome-wsl --cdp` expõe CDP em `127.0.0.1:9222`; com
> `PUPPETEER_CDP_URL=http://127.0.0.1:9222` o scraper conecta nele em vez de lançar o seu, usa a
> mesma sessão logada e fecha só a própria aba. Foi assim que as seis lojas foram reconferidas em
> 06/11/2026. Sem isso, e com o perfil ocupado, o erro vem explicado em uma linha em vez de um
> stack trace do Puppeteer.

As contas desse perfil são reais. O scraper só **lê** página de produto. Nada de postar, comentar,
mandar mensagem ou comprar.

## Shopee: por que fica desligada (e por que o código continua lá)

A página de produto é casca JS, sem preço nenhum no HTML. O preço vem de
`/api/v4/pdp/get_pc`, que responde **403 a fetch direto** — quer um header de assinatura anti-bot
que a própria página calcula. Único caminho possível: deixar a página chamar a API dela e capturar
a resposta. O `scrapeWithBrowser` faz isso e injeta o payload de volta no HTML como
`<script id="__SHOPEE_PDP__">`.

Medido em 06/11/2026, inclusive com o perfil logado: a captura chega com **HTTP 200 e payload
anti-bot** (`{"error":90309999}`), e a aba é redirecionada para `/verify/captcha`.

O caminho ficou no código porque não custa nada e é a única forma que **pode** funcionar: uma
sessão que tenha passado o captcha à mão volta a devolver dado real sem mudar uma linha. Até lá o
scraper devolve `{}` e o fallback de IA assume.

## Magazine Luiza: sem caminho

403 em HTTP puro, em puppeteer-stealth e no perfil logado — os três. Está em
`BR_UNSUPPORTED_SITES`, e `scrapeProduct` falha cedo com a razão por escrito em vez de gastar um
browser. Os 9 produtos Magalu do price-tracker são importados **pausados**, para não desaparecerem
do catálogo.

## Adicionar uma loja nova

1. Mede primeiro, nos três caminhos. `curl` com UA de navegador; depois puppeteer-stealth; depois
   perfil logado. Anota o status real e **cola a evidência aqui**.
2. Acha a fonte do preço na ordem: `__NEXT_DATA__` / JSON `<script>` → JSON-LD `offers` →
   elemento com classe semântica → texto. Prefira JSON: classe muda, campo de JSON muda menos.
3. Confira se a loja tem preço à vista separado. Se tiver, o scraper devolve **o à vista**.
4. Cuidado com classes hasheadas por build (`mui-1jk88bq-price_vista-…` na Pichau). Case no sufixo
   semântico com `[class*=]` e use `firstPrice()`, que pula o rótulo (`[class*="price_vista"]` casa
   com o texto "à vista" antes de chegar no número).
5. Precisa de browser → `BR_BROWSER_SITES`. Precisa de login → `BR_LOGGED_PROFILE_SITES`. Renderiza
   o preço tarde → `BR_WAIT_SELECTORS`. Sem caminho nenhum → `BR_UNSUPPORTED_SITES` com a razão.
6. Teste no pipeline inteiro, não só no seletor: o que importa é qual candidato **ganha a votação**.

## Importar o catálogo do price-tracker

Ver [`backend/scripts/import-price-tracker.ts`](../backend/scripts/import-price-tracker.ts) e a
skill `importar-price-tracker`. Resumo: 548 produtos distintos em 53 hosts, e 23 rodadas de coleta
no git log do `build/data.json` viram ~1.800 pontos reais de histórico.

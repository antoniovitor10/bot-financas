# bot-financas

MVP de bot do Telegram para interpretar lancamentos financeiros e gravar transacoes no Organizze com confirmacao explicita antes do envio.

## Estrutura

```text
src/
  bot/handlers/        handlers Telegram de texto, voz, documento, imagem e callbacks
  parsers/             parser de texto, voz, OFX, CSV, valores e datas auxiliares
  services/            Organizze, categorizacao, confirmacao, transcricao e importacao
  repositories/        SQLite local para aliases, catalogo, pendencias e importacoes
  types/               modelos TypeScript de financas e Organizze
  utils/               datas, dinheiro e logger
  app.ts               bootstrap do bot
  config.ts            variaveis de ambiente
```

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Configure `TELEGRAM_BOT_TOKEN`, `ORGANIZZE_EMAIL`, `ORGANIZZE_TOKEN` ou `ORGANIZZE_API_KEY`, e `ORGANIZZE_USER_AGENT`.

Para voz, configure `OPENROUTER_API_KEY` ou `OPENAI_API_KEY`. O bot envia audio OGG do Telegram direto para o provedor de transcricao; `ffmpeg` so e usado como fallback para formatos nao suportados.

## Comandos do bot

- `/start` mostra o uso basico.
- `/sync` atualiza contas, categorias e cartoes do Organizze.
- `/aliases` lista aliases locais.
- `/alias conta apelido=123` cria alias de conta.
- `/alias categoria mercado=456` cria alias de categoria.
- `/alias cartao nubank=789` cria alias de cartao.
- `/cancelar` remove confirmacoes pendentes do chat.
- `/vencer` lista contas a vencer nos proximos 7 dias.
- `/semana` lista contas da semana.
- `/mes` lista contas a vencer no mes atual.
- `/pagar ID` marca um lancamento como pago.
- `/faturas` lista cartoes disponiveis para consulta.
- `/fatura cartao` mostra a fatura mais relevante do cartao.
- `/editar_conta ID nome=Novo Nome tipo=checking descricao=Texto` edita conta no Organizze.
- `/editar_cartao ID nome=PicPay vencimento=5 fechamento=29 limite=6700 bandeira=mastercard` edita cartao no Organizze.
- `/ajustar conta caixa para 1000 categoria outros` cria um lancamento de ajuste para acertar saldo.

Comandos sao sensiveis a caixa: use `/sync`, nao `/Sync`.

## Testes rapidos

Depois de configurar `.env`, rode:

```bash
npm run dev
```

No Telegram:

```text
/sync
/aliases
gastei 42,90 no mercado hoje no nubank categoria mercado
gastei 350 hoje na caixa categoria emprestimo
```

Se faltar categoria, conta ou cartao, crie um alias apontando para o ID listado em `/aliases`:

```text
/alias categoria emprestimo=79404723
/alias cartao nubank=1723021
/alias conta caixa=6272892
```

Para testar importacao, envie no Telegram um arquivo `.ofx`, `.csv`, `.pdf` ou uma foto/imagem de comprovante/fatura.

CSV e OFX sao processados localmente. PDF de fatura Nubank e PicPay digitais tambem sao processados localmente para evitar custo e erro de OCR. Outros PDFs e imagens usam OpenRouter e retornam um lote de revisao, sem gravar automaticamente no Organizze.

Audio pode conter mais de uma transacao. O bot transcreve, tenta extrair todas as transacoes via OpenRouter e envia cada uma para confirmacao individual. Frases com `emprestei` viram uma operacao composta: saida paga agora e conta a receber futura.

## Fluxo MVP

1. Texto ou audio vira `ParsedTransaction`.
2. `Categorizer` tenta resolver conta/cartao/categoria por aliases e catalogo local.
3. Se faltar campo obrigatorio, o bot pergunta o que falta e nao envia nada.
4. Se os campos minimos existem, o bot sempre mostra resumo com botoes `Confirmar` e `Cancelar`.
5. Ao confirmar, `OrganizzeApiService` envia `POST /transactions` com Basic Auth e `User-Agent`.
6. Arquivos OFX/CSV/PDF/imagem entram em pipeline separado: parseiam transacoes, cruzam com lancamentos existentes no periodo e salvam lote local para revisao.

## Observacoes de MVP

- O parser de texto e heuristico e local. Ele funciona para frases comuns como `gastei 42,90 no mercado hoje no nubank categoria mercado` e deve ser substituido por um parser LLM quando a semantica ficar mais ampla.
- Em parcelamentos, o valor informado e enviado como o valor do lancamento. Se voce quiser tratar frases como valor total a dividir por parcelas, ajuste `src/parsers/text-parser.ts`.
- OFX, CSV, PDF e imagem ainda nao gravam transacoes automaticamente; eles preparam candidatos e marcam possiveis duplicados para conciliacao.
- Fatura Nubank digital usa parser local: ignora pagamentos recebidos, trata estornos como credito, preserva datas reais das compras e valida o liquido contra o total da fatura.
- Fatura PicPay digital usa parser local: ignora pagamento de fatura/boleto, preserva final do cartao em notas, detecta parcelas `PARC04/06` e valida os lancamentos contra o total geral.
- Contas futuras ou a vencer devem ser criadas com linguagem como `boleto vence dia 20` ou `conta de luz para pagar dia 20`; o bot envia `paid=false` para o Organizze. Lancamentos com `paguei`, `gastei` ou `recebi` entram como pagos.
- Para outros PDFs digitais, `OPENROUTER_PDF_ENGINE=cloudflare-ai` evita custo extra de OCR. Se falhar, o bot tenta `OPENROUTER_PDF_FALLBACK_ENGINES=native,mistral-ocr`; `mistral-ocr` custa mais, mas costuma lidar melhor com faturas escaneadas ou PDFs complicados.
- Audio e processado em segundo plano para nao estourar o timeout do Telegram. OGG do Telegram nao depende de `ffmpeg`. Timeouts ajustaveis: `TELEGRAM_HANDLER_TIMEOUT_MS=300000`, `TRANSCRIPTION_REQUEST_TIMEOUT_MS=75000`, `OPENROUTER_REQUEST_TIMEOUT_MS=45000`.

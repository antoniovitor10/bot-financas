# bot-financas

Bot de Telegram (TypeScript, telegraf, better-sqlite3) que interpreta lançamentos financeiros e grava no Organizze (ou FinControl via `FINANCE_BACKEND=fincontrol`), sempre com confirmação. Ver README.md para estrutura e comandos.

## Estado atual (25/10/2026)

O Vitor nao usa mais o bot do Telegram. O que esta em uso:

- `scripts/pluggy-diario.ts`: rotina diaria (tarefa agendada no app do Claude, 8h) que le a Pluggy, lanca o que e novo no Organizze por regras (duplicado fora, iFood em "Lanches e besteiras", categoria sugerida, senao "Não identificado") e regrava `data/painel/*.json`.
- `scripts/painel-export.ts`: exporta do Organizze os dados do Painel das Financas (artifact Dashboard https://claude.ai/artifact/PkzscexSk4yztKixYtrVgF). Ciclos de fatura corrigidos e boletos previstos ficam em CICLOS e PREVISTOS nesse arquivo.
- `scripts/pluggy-import-decisoes.ts`: aplica decisoes de uma revisao manual (pasta de JSON) no Organizze.
- `docs/PLANO-PLUGGY.md`: fatos da API da Pluggy e licoes da primeira carga.

O codigo do bot (src/bot) continua compilando e testado, mas nao roda.

## Regras

- Nunca imprimir o conteúdo do `.env` nem valores de secret em logs ou respostas.
- `.env` tem valores com espaço (PLUGGY_ITEMS), então não usar `source .env` no bash; ler pelo dotenv ou por script.
- Novas fontes de dados entregam transações para a camada de backend, nunca chamam o Organizze direto.
- Textos para o Vitor sem travessões.

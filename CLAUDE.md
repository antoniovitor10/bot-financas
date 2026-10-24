# bot-financas

Bot de Telegram (TypeScript, telegraf, better-sqlite3) que interpreta lançamentos financeiros e grava no Organizze (ou FinControl via `FINANCE_BACKEND=fincontrol`), sempre com confirmação. Ver README.md para estrutura e comandos.

## Trabalho em andamento

Integração com Pluggy (Open Finance via Meu Pluggy) para entrada automática de transações. Leia `docs/PLANO-PLUGGY.md` antes de mexer: tem o status, os fatos da API já testados e a arquitetura combinada.

## Regras

- Nunca imprimir o conteúdo do `.env` nem valores de secret em logs ou respostas.
- `.env` tem valores com espaço (PLUGGY_ITEMS), então não usar `source .env` no bash; ler pelo dotenv ou por script.
- Novas fontes de dados entregam transações para a camada de backend, nunca chamam o Organizze direto.
- Textos para o Vitor sem travessões.

# Plano: entrada automática via Pluggy (Meu Pluggy)

Objetivo: parar de mandar extratos, fotos e PDFs na mão. O bot busca as transações dos bancos sozinho pela API da Pluggy, categoriza com o que já aprendeu e lança no backend financeiro (Organizze hoje). Só o que o bot não souber classificar vira pergunta no Telegram com botões.

## Status (24/10/2026, tarde)

Implementado e testado (20 testes passando, `npm test`), ainda nao rodado em producao:

- `src/services/pluggy-api.ts`: auth com cache da apiKey (renova em 401/403), getItem, listAccounts, listTransactions v2 seguindo o cursor `next`.
- `src/repositories/pluggy-repo.ts`: tabelas `pluggy_accounts`, `pluggy_account_map`, `pluggy_transactions` (pluggy_id PK, status deferred/ignored/batched/imported, payload_json, batch_id, backend_tx_id) e `pluggy_sync_state`.
- `src/services/pluggy-sync.ts`: para cada conta mapeada busca desde o ultimo `createdAt` (com 3 dias de sobreposicao), normaliza para `ParsedTransaction` (source `pluggy`), passa pelo Categorizer e monta um `ImportBatch` igual ao de OFX/PDF. Confirmar o lote e o que grava no backend (e marca `imported`). Nunca chama o Organizze direto.
- `src/bot/handlers/pluggy.ts`: `/pluggy`, `/pluggy contas`, `/pluggy mapear`, `/pluggy status`. Agendamento em `src/app.ts` (20 s apos subir e a cada `PLUGGY_SYNC_MINUTES`, aviso em `PLUGGY_NOTIFY_CHAT_ID`).
- Mapeamento conta Pluggy -> backend: automatico pelo nome do banco (alias exato primeiro, depois mencao); cartao para contas CREDIT, conta so para CHECKING. Poupanca fica sem mapeamento ate o Vitor mapear ou ignorar.
- Decisoes tomadas: parcelas futuras ficam `deferred` e entram quando a data chega (nao usa installments_attributes, senao o Organizze criaria parcelas em dobro); PENDING entra normalmente (no cartao quase tudo e PENDING ate fechar a fatura); categorias de transferencia/pagamento de fatura/investimento vao sempre para revisar.
- Ensaio real somente leitura feito em 24/10 com banco temporario e corte 2026-10-01: ver secao "Ensaio" abaixo.

### Status anterior (24/10/2026, manha)

- Meu Pluggy com 5 conexões ativas (limite do plano gratuito é 5): Nubank, Mercado Pago, Caixa, PicPay, Inter.
- PicPay Empresas NÃO entra (limite de 5). Continua pelo fluxo atual de PDF/OFX.
- Dashboard Pluggy: aplicação "Pluggy Demo App" (org "fincontrol"), com os 5 bancos ligados pelo conector MeuPluggy (proxy, sem pedir CPF de novo).
- Trial do Dashboard expirado, mas o guia do Meu Pluggy diz que ler os próprios dados por esse caminho é gratuito e não vence.
- `.env` já tem PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET e PLUGGY_ITEMS (formato `itemId=Banco,itemId=Banco`). Atenção: "Mercado Pago" tem espaço, então não dá pra fazer `source .env` no bash.
- Autenticação testada e OK. `scripts/pluggy-probe.py` é o teste usado.

## Fatos da API (confirmados testando)

- `POST https://api.pluggy.ai/auth` com clientId/clientSecret devolve `apiKey` (header `X-API-KEY`).
- `GET /items/{id}` funciona. `GET /items` (listar) dá 403 em conta Meu Pluggy: por isso os IDs ficam no .env.
- `GET /accounts?itemId=...` funciona.
- `GET /transactions` está DEPRECIADO (410). Usar `GET /v2/transactions?accountId=...` com paginação por cursor: a resposta tem `results` (500 por página) e `next` como query string (`?accountId=...&after=...`) para anexar em `/v2/transactions`.
- Filtros do v2 testados em 24/10: só `accountId` e `createdAtFrom=YYYY-MM-DD` funcionam. `from`, `to`, `pageSize`, `page`, `cursor`, `limit`, `createdAtTo` e `updatedAtFrom` dão 400 ("property X should not exist"). `createdAtFrom` filtra pela data em que a Pluggy registrou a transação, por isso o sync incremental usa ele com sobreposição e deduplica por id.
- Sinal do valor: no cartão a compra vem com `amount` positivo e `type` DEBIT, estorno negativo e CREDIT; na conta o débito vem negativo. O sentido certo é o `type`, nunca o sinal.
- No cartão quase tudo fica `status: PENDING` até a fatura fechar (Nubank: 17 de 17 em outubro). Na conta corrente vem `POSTED`.
- `creditCardMetadata` traz `installmentNumber`, `totalInstallments`, `purchaseDate`, `billPostDate`, `paymentType` (SINGLE/INSTALLMENT) e `cardNumber` (final). A descrição já vem com "2/2".
- Contas encontradas: Mercado Pago (conta + cartão Visa), Caixa (cartão Visa Gold, 2 poupanças, 1 corrente), PicPay (cartão Master Black + conta), Inter (corrente + cartão Master), Nubank (cartão Master + conta).
- Campos da transação: id, accountId, date, amount, description, descriptionRaw, category, categoryId, type (DEBIT/CREDIT), status, creditCardMetadata, merchant, paymentData, operationType, balance, providerId.
- Cartão de crédito traz parcelas FUTURAS já lançadas (ex.: "Loja 5/5" com data em 2027). Decidir: lançar só até hoje, ou casar com o lançamento parcelado do Organizze.
- O item no Demo não sincroniza sozinho (`nextAutoSyncAt` null é normal). Quem atualiza é a conexão original no Meu Pluggy, a cada 24h. `refresh` pela API não funciona para itens Meu Pluggy.
- Webhook disponível (item/updated, transactions/created, transactions/updated, transactions/deleted). Exige URL pública HTTPS.

## Arquitetura a implementar

1. `src/services/pluggy-api.ts`: auth (cache da apiKey), getItem, listAccounts, listTransactions (v2, seguindo `next` até acabar).
2. `src/services/pluggy-sync.ts`: para cada item/conta, busca desde o último sync, ignora o que já foi processado, normaliza para `ParsedTransaction` e manda para a mesma camada que hoje escolhe Organizze ou FinControl (`FINANCE_BACKEND`). Nunca falar com Organizze direto daqui, para a troca de backend continuar sendo só configuração.
3. SQLite: tabela `pluggy_transactions` (pluggy_id PK, account_id, date, amount, status, backend_tx_id, processed_at) e `pluggy_sync_state` (account_id, last_synced_at).
4. Mapeamento conta/cartão Pluggy para conta/cartão do Organizze: usar os aliases existentes ou uma tabela nova `pluggy_account_map`.
5. Categorização em camadas: learning-repo (padrões aprendidos) > categoria da Pluggy mapeada para categoria do Organizze > OpenRouter. Confiança alta lança direto. Baixa vai pro Telegram com botões (callbacks já existem), e a escolha alimenta o learning-repo.
6. Agendamento: rodar ao iniciar o bot e a cada poucas horas. Webhook `/webhooks/pluggy` opcional que só dispara o mesmo sync (o bot já roda em servidor).
7. Resumo diário no Telegram: quantos lançados automaticamente e quantos pendentes.
8. Transações com status PENDING: decidir se espera virar POSTED ou lança e atualiza depois.

## Antes de ligar em produção: data de corte

Tudo que já foi lançado no Organizze (manual ou por extrato) vai chegar de novo pela Pluggy. Definir DATA DE CORTE (pendente: perguntar ao Vitor até quando já lançou tudo).
- Depois do corte: Pluggy lança automaticamente.
- Antes do corte: só conciliar (valor + data + descrição) contra o Organizze e listar o que falta, sem lançar sozinho.

## Ensaio real de 24/10/2026 (somente leitura, banco SQLite temporário, corte 2026-10-01)

- 12 contas lidas em 3,8 s. Mapeadas sozinhas: Mercado Pago (conta e cartão), Caixa corrente, PicPay (conta e cartão), Inter (conta e cartão), Nubank cartão.
- Sem mapeamento (precisam de decisão): cartão "CAIXA VISA GOLD CREDITO" (não existe cartão Caixa no Organizze: criar lá e rodar /sync, ou ignorar), as duas poupanças da Caixa e a conta "Nu Pagamentos" do Nubank (saldo R$ 1,09).
- Resultado: 133 transações desde 01/10 (65 prontas, 66 para revisar, 2 duplicadas), 48 parcelas futuras adiadas, 2.477 anteriores ao corte guardadas como ignoradas.
- O que caiu em revisar: Pix entre contas próprias, Pix para pessoas, pagamentos de boleto/fatura e 43 itens sem categoria resolvida (descrições cruas de extrato como "DEB PIX CHAVE"). É o alvo da terceira camada (OpenRouter) ou de aliases/aprendizado com o uso.
- Bug de ambiente achado e corrigido: better-sqlite3 11.10 trava com "Assertion failed: (env) != nullptr" no Node 24 sempre que um statement é coletado pelo GC. Atualizado para better-sqlite3 13.0.3 (package.json). Se o servidor roda Node 20/22, continua funcionando.

## Próximos passos

1. Subir o bot com as variáveis novas (`PLUGGY_START_DATE`, `PLUGGY_NOTIFY_CHAT_ID`) e rodar `/pluggy contas` para conferir os mapeamentos automáticos e decidir as poupanças da Caixa (mapear ou ignorar).
2. Rodar `/pluggy`, revisar o primeiro lote e confirmar. A partir daí o sync agendado só avisa quando há coisa nova.
3. Depois de alguns lotes: medir quantos itens caem em "revisar" e, se valer, ligar a terceira camada (OpenRouter) para categorizar o que aliases e aprendizado não resolvem.
4. Opcional: webhook `/webhooks/pluggy` disparando o mesmo sync; resumo diário no Telegram.

## Pendências do Vitor

- Informar a data de corte.
- Opcional: apagar no Dashboard os itens de teste ("Pluggy Bank" x2 e o MeuPluggy de 02/07 com USER INPUT TIMEOUT).

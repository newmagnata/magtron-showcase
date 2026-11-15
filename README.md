# MAGTRON (amostra)

Plataforma de atendimento e automação para WhatsApp: chats em tempo real, CRM Kanban, editor visual de fluxos com simulador, agentes de IA, disparos em massa, webhooks e servidor MCP para conectar ao Claude.

> Versão de demonstração para portfólio, sem histórico, sem chaves e sem dados reais.

## Recursos
- Chats em tempo real (Socket.IO) e CRM Kanban
- Editor visual de fluxos com blocos (mensagem com vários conteúdos, condições, esperas, IA, webhooks) e simulador
- Conexões com Evolution API e API oficial da Meta, além de modo Sandbox para testar sem WhatsApp
- Agentes de IA e blocos com Anthropic
- Disparos em massa, importação de contatos e trackeamento
- Servidor MCP para operar fluxos e contatos pelo Claude
- Segurança: cadastro por convite, trava de login, CSP e cabeçalhos, limite de requisições, validação de uploads, proteção contra SSRF, assinatura de webhook, contêiner sem root

## Tecnologias
Node.js 24 · TypeScript · Fastify · React + Vite · @xyflow/react · PostgreSQL (PGlite embutido em desenvolvimento) · Docker · Vitest

## Como rodar
```bash
npm install
npm run build
npm start
```
Abra http://localhost:3333 e crie a conta. Sem `DATABASE_URL`, o banco fica em `.data/pg`. Para desenvolver com recarga, use `npm run dev` (porta 5173). Copie `.env.example` para `.env` e preencha o que precisar. Testes: `npm test`.

Para experimentar sem WhatsApp, crie uma conexão **Sandbox** e use o simulador em Conexões.

## Segurança
Veja [`SECURITY.md`](SECURITY.md). Nenhum segredo é versionado.

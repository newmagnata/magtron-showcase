# Segurança do MAGTRON

Revisão completa feita em 10/11/2026 (veredito: **aprovado com ressalvas**; ver relatório em `Segundo-Cerebro/Projetos/magtron/SEGURANCA.md`).

## O que está protegido

| Área | Como |
|---|---|
| Login | scrypt assíncrono com sal; senha nova com 10+ caracteres; e-mail inexistente e senha errada respondem igual (mesmo tempo); 8 erros seguidos travam o e-mail por 15 min e avisam o dono; 20 tentativas/min por IP |
| Cadastro | Fechado depois do primeiro usuário. Equipe entra por convite (válido 7 dias, uso único). Para abrir: `ALLOW_REGISTRATION=true` |
| Sessão | JWT HS256 de 7 dias no header `Authorization` (sem cookie, portanto sem CSRF); cada pedido confere se a pessoa ainda pertence à empresa; o socket também |
| Papéis | `owner`/`admin`/`agent` checados no servidor; atendente não escreve fora de chats/contatos/kanban e não lê credenciais, integrações nem eventos de segurança |
| Dados | Todas as consultas usam parâmetros; todo `:id` filtra pela empresa da sessão; entradas validadas com zod |
| Navegador | CSP (`script-src 'self'`, `frame-ancestors 'none'`), `nosniff`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP, HSTS com HTTPS, `Cache-Control: no-store` na API; sem CORS aberto |
| Limites | 300 pedidos/min por IP (webhooks e mídia ficam de fora); MCP 120/min |
| Uploads | Lista de tipos, conferência dos bytes iniciais, máximo 16 MB, nome limpo; só imagem/vídeo/áudio/PDF abrem no navegador (com `sandbox`); SVG/HTML/JS recusados |
| SSRF | Endereço da Evolution própria e URLs de mídia/HTTP dos fluxos precisam ser públicos (barra rede interna, metadados, `file:`, `javascript:`); a chave do servidor nunca vai para endereço escolhido por usuário |
| Segredos | Chaves de integração cifradas (AES-256-GCM); MCP guarda só o hash; `APP_SECRET` fraca derruba o servidor em produção |
| Registro | Tabela `security_events` (login errado, bloqueio, 403, upload recusado, SSRF, webhook com token errado, MCP inválido, limite excedido). Admin lê em `GET /api/security/events` |
| Contêiner | Roda como usuário `node`, sem capacidades, `no-new-privileges`, sistema de arquivos somente leitura, imagem da Evolution fixada por digest; Postgres e Redis sem porta publicada; MAGTRON e Evolution só em `127.0.0.1` |

## Variáveis

`ALLOW_REGISTRATION` (padrão `false`), `TRUST_PROXY` (`true` só atrás de proxy local), `RATE_LIMIT_MAX`, `ALLOW_PRIVATE_URLS` (**só testes**; nunca em produção).

## Antes de expor na internet (VPS)

1. HTTPS na frente (Caddy) e `PUBLIC_URL=https://seu-dominio`.
2. Manter a porta 3333 em `127.0.0.1` e `TRUST_PROXY=true` apenas com o Caddy no mesmo servidor.
3. Firewall liberando só 80/443 (e SSH por chave).
4. Backup diário do banco guardado fora do servidor.

## Testes

`npx vitest run --no-file-parallelism`: `tests/security.test.ts` ataca autenticação, tokens adulterados, IDOR, injeção SQL, XSS, uploads, SSRF, limites, webhooks e MCP.

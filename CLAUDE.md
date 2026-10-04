@AGENTS.md

## Notas para Claude Code

- Antes de cambiar contratos en `packages/shared` o `apps/server/src/services/types.ts`, revisa quién los usa
  (`grep -r`), porque servidor e interfaz dependen de ellos.
- Verifica tus cambios con `pnpm typecheck` y `pnpm test` antes de dar algo por terminado.
- Para motion graphics con HyperFrames, lee primero `.agents/skills/hyperframes-core/SKILL.md` si existe.

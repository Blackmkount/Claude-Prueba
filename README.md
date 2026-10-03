# BlackForge Print

App web para enviar impresiones ya laminadas (`.gcode.3mf`) a impresoras
Bambu Lab A1 del taller BlackForge desde el celular, por la red local.

> **Estado:** Fase 1 (prueba del protocolo). Ver [`docs/PLAN.md`](docs/PLAN.md).
> Las instrucciones completas de instalación se escriben en la Fase 5.
>
> Esta app está pensada **solo para la red local del taller. No la expongas a internet.**

## Probar el protocolo con tu impresora (Fase 1)

Sigue [`docs/fase-1-prueba-real.md`](docs/fase-1-prueba-real.md). En resumen:

```bash
npm install
cp .env.example .env        # y escribe la IP y el código de acceso de tu A1
npm run cli -- diagnostico
npm run cli -- imprimir prueba.gcode.3mf
```

## Para desarrollo

```bash
npm test          # pruebas (incluye impresoras simuladas)
npm run sim       # 10 impresoras A1 simuladas
npm run cli -- ayuda
```

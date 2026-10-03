# BlackForge Print

Versión del taller **BlackForge** de [Bambuddy](https://github.com/maziggy/bambuddy),
el gestor autoalojado de impresoras Bambu Lab por la red local.

Sobre Bambuddy añadimos el **modo taller**: las operarias eligen en el celular
un producto, la cantidad y una impresora libre, y envían a imprimir en menos de
30 segundos, sin poder mandar a una impresora ocupada o con una pieza en la cama.

| Documento | Para qué |
|---|---|
| [`PLAN.md`](./PLAN.md) | Plan, fases, qué aporta Bambuddy y qué construimos |
| [`actualizar-en-mac.md`](./actualizar-en-mac.md) | Pasar el Mac del taller a BlackForge Print y actualizarlo |
| [`instalar-en-mac.md`](./instalar-en-mac.md) | Probar Bambuddy oficial en el Mac con la A1 (Fase 1, ya hecha) |
| [`docker-compose.mac.yml`](./docker-compose.mac.yml) | Construir y correr nuestra imagen en el Mac |
| [`simulador/`](./simulador/) | Impresoras A1 falsas para desarrollar y probar sin el taller |
| [`protocolo-a1.md`](./protocolo-a1.md) | Protocolo LAN de la A1 y lo observado en la impresora real |
| [`identidad/propuesta.html`](./identidad/propuesta.html) | Identidad visual aprobada |

> Solo para la red local del taller: no se expone a internet.

## Licencia

Igual que Bambuddy, **AGPL-3.0** (ver [`LICENSE`](../LICENSE)). Crédito a
Bambuddy y sus colaboradores. Quienes usan la app por la red pueden obtener el
código fuente de esta versión.

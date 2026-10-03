# Simulador de impresoras A1

Impresoras Bambu Lab A1 falsas (MQTT con TLS y FTPS, como las reales) para
desarrollar y probar BlackForge Print sin el taller. Es una herramienta de
desarrollo: no se incluye en la app ni en la imagen Docker.

```bash
cd blackforge/simulador
npm install
npm run sim -- --ayuda
```

## Conectarlo a Bambuddy

Bambuddy siempre usa los puertos reales (8883 MQTT y 990 FTPS), así que cada
impresora simulada necesita su propia IP. En Linux sirven `127.0.0.2`,
`127.0.0.3`… sin configurar nada (el puerto 990 pide permisos de administrador):

```bash
sudo npm run sim -- --ip-base 127.0.0.2 --impresoras 3 --sin-puback --datos .sim
```

La tabla que muestra trae la IP, la serie y el código de acceso de cada una:
agrégalas en Bambuddy a mano (modelo A1). `--sin-puback` imita a la A1 real,
cuyo broker no confirma los comandos.

## API de control (puerto 18799)

Para provocar situaciones desde pruebas o a mano:

```bash
curl http://127.0.0.1:18799/impresoras                          # estado y archivos de la microSD
curl -X POST http://127.0.0.1:18799/impresoras/<serie>/terminar  # termina la impresión ya
```

Acciones (`POST /impresoras/<serie>/<acción>`, cuerpo JSON opcional):
`terminar`, `fallar`, `desconectar` (`{"ms": 5000}`), `zombi`,
`microsd` (`{"presente": false}`), `modo-desarrollador` (`{"activo": false}`),
`filamento`, `mañas`, `impresion-externa`, `reiniciar-estado`.

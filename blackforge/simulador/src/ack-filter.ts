// Filtro para imitar al broker de Bambu, que no envía los acuses MQTT (PUBACK)
// de forma confiable. Se coloca entre el socket TLS y aedes: lo que aedes
// escribe hacia el cliente se interpreta paquete por paquete y se descartan los
// PUBACK. Lo que llega del cliente pasa tal cual.
import { Duplex } from "node:stream";
import type tls from "node:tls";
import mqttPacket from "mqtt-packet";

export function dropOutgoing(socket: tls.TLSSocket, shouldDrop: (cmd: string) => boolean): Duplex {
  const parser = mqttPacket.parser({ protocolVersion: 4 });
  const duplex = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      parser.parse(chunk);
      callback();
    },
    final(callback) {
      socket.end();
      callback();
    },
    destroy(err, callback) {
      socket.destroy();
      callback(err);
    },
  });
  parser.on("packet", (packet) => {
    if (!shouldDrop(packet.cmd)) socket.write(mqttPacket.generate(packet));
  });
  socket.on("data", (data: Buffer) => duplex.push(data));
  socket.on("end", () => duplex.push(null));
  socket.on("close", () => duplex.destroy());
  socket.on("error", (err) => duplex.destroy(err));
  return duplex;
}

# trama

[![ci](https://github.com/KlGamers/trama/actions/workflows/ci.yml/badge.svg)](https://github.com/KlGamers/trama/actions/workflows/ci.yml)

Documentos local-first para apps web y Flutter. Cada dispositivo edita su
copia sin conexión y, cuando vuelve la red, todas las copias se fusionan solas
y terminan idénticas, sin conflictos que resolver a mano.

Incluye dos implementaciones con el mismo formato binario, TypeScript y Dart,
y un servidor de sincronización autohospedado en Go.

```ts
import { Doc, SyncClient } from "trama";

const doc = new Doc();
doc.change((r) => {
  r.set("titulo", "Lista del súper");
  r.list("items").push("tortillas");
  r.text("notas").insert(0, "Comprar antes del viernes");
  r.counter("votos").increment();
});

new SyncClient(doc, { url: "wss://tu-servidor/sync", doc: "super" }).start();
```

```dart
final doc = Doc();
doc.change((r) => r.list('items').push('aguacates'));
SyncClient(doc, url: Uri.parse('wss://tu-servidor/sync'), docName: 'super').start();
```

## Por qué

Para la web existen Yjs y Automerge. Para Flutter casi no hay nada: las
opciones son usar un servicio en la nube que decide por ti cuando hay
conflictos, o escribir tu propia lógica de fusión. trama da a una app web y a
una app Flutter el mismo modelo de datos, el mismo formato y el mismo servidor,
así que pueden editar el mismo documento al mismo tiempo.

## Tipos de datos

| Tipo | API | Qué pasa con ediciones simultáneas |
|---|---|---|
| Mapa | `set`, `get`, `delete`, `keys` | Gana la escritura con el identificador de operación más alto, igual en todas las réplicas |
| Lista | `insert`, `push`, `delete`, `get` | Se conservan todas las inserciones; las que caen en la misma posición se ordenan igual en todas las réplicas |
| Texto | `insert`, `delete`, `toString` | Igual que la lista, carácter por carácter, contando puntos de código Unicode |
| Contador | `increment` | Se suman todos los incrementos |

Los objetos se anidan: mapas dentro de listas, listas dentro de mapas, texto
dentro de cualquiera.

**Dos réplicas que crean lo mismo sin conexión no pierden nada.** Si dos
teléfonos sin red ejecutan `r.counter("votos")` o `r.text("notas")`, los dos
apuntan al mismo objeto, porque su identidad sale del padre, la clave y el
tipo. En Yjs y Automerge cada creación es un objeto distinto y al fusionar uno
de los dos se descarta, así que recomiendan crear la estructura antes de
editar. Si borras una clave y la vuelves a crear, el objeto nuevo empieza
vacío.

## Garantías y cómo se prueban

| Prueba | Qué comprueba |
|---|---|
| Unitarias | Cada tipo, cada operación, errores de rango, entrega fuera de orden, guardar y cargar |
| Contra un modelo | Ediciones aleatorias en una réplica deben dar exactamente lo mismo que arreglos y objetos simples, también en una segunda réplica que recibe los cambios |
| Convergencia | De 2 a 4 réplicas editan al mismo tiempo; los cambios llegan desordenados, duplicados y en lotes, y todas deben terminar idénticas |
| Conformidad cruzada | 120 escenarios y 6,759 cambios: Dart reproduce lo que genera TypeScript y viceversa, con el mismo documento final, los mismos bytes al volver a codificar y el mismo archivo guardado |
| Servidor | Validación de cada cambio con fuzzing, almacenamiento, tokens, permisos y salas con clientes WebSocket reales |
| De punta a punta | Un cliente de Node y uno de Dart editan el mismo documento sin conexión, sincronizan con el servidor real, y réplicas nuevas en ambos lenguajes ven lo mismo |

Para comprobar que las pruebas sirven, inyecté seis errores a mano en el
algoritmo y la suite detectó los cinco que eran errores reales. El sexto
cambiaba el tamaño de bloque interno, que no debe alterar el resultado, y en
efecto no lo alteró.

## Rendimiento

La traza de edición estándar del área: 259,778 pulsaciones reales al escribir
un artículo académico, de [automerge-perf](https://github.com/automerge/automerge-perf).
Node 24 en una laptop Apple Silicon.

| | trama | Yjs 13 | Automerge 3 |
|---|---|---|---|
| Aplicar las ediciones, un cambio por pulsación | **1.28 s** | 1.35 s | 15.0 s |
| Aplicarlas en otra réplica | 1.08 s | - | - |
| Tamaño del documento guardado | 1.15 MB | 311 kB | 129 kB |
| Cargar el documento guardado | 1.32 s | 17 ms | 0.92 s |
| Memoria de JavaScript | 31 MB | 3 MB | no comparable, vive en wasm |

Qué dicen los números:

- Aplicar ediciones es tan rápido como Yjs y doce veces más rápido que
  Automerge.
- El archivo guardado pesa 3.7 veces lo de Yjs y 9 veces lo de Automerge.
  trama guarda el historial completo de cambios. Las rachas de escritura y de
  borrado se comprimen a 2 o 3 bytes por pulsación, pero no llega a los
  formatos por columnas de Automerge.
- **Cargar es el punto más débil:** trama vuelve a aplicar todo el historial.
  Yjs carga directamente su estructura interna y es 77 veces más rápido en
  este caso.
- Si las ediciones se agrupan en menos cambios, todo mejora: con la traza
  completa en un solo cambio, trama guarda 531 kB y carga en 128 ms.

Para reproducirlo:

```sh
cd js && npm install && npm run build
node --expose-gc bench/trace.mjs
```

## Servidor

```sh
cd server
go build -o trama-server ./cmd/trama-server
TRAMA_SECRET=un-secreto-largo ./trama-server -addr :7070 -db trama.db
```

Los clientes se conectan a `ws://servidor:7070/sync`. Sin `TRAMA_SECRET`
cualquiera puede leer y escribir cualquier documento, útil solo en
desarrollo.

Tokens por documento, firmados con HMAC-SHA256:

```sh
TRAMA_SECRET=un-secreto-largo ./trama-server token -doc super -ttl 24h
TRAMA_SECRET=un-secreto-largo ./trama-server token -doc super -read-only
```

- Guarda el historial de cada documento en SQLite.
- Valida la estructura completa de cada cambio antes de aceptarlo, así un
  cliente con errores no puede dañar el documento de los demás.
- Rechaza un cambio si falta uno anterior del mismo autor.
- Reenvía cada cambio nuevo a los demás clientes del documento y confirma al
  autor la versión que ya tiene guardada.
- `GET /healthz` devuelve el número de documentos y cambios.

### Protocolo

Mensajes binarios sobre WebSocket:

| Mensaje | Dirección | Contenido |
|---|---|---|
| `hello` | cliente → servidor | Documento, token y vector de versión del cliente |
| `welcome` | servidor → cliente | Vector de versión del servidor y si el token permite escribir |
| `changes` | ambos | Lista de cambios codificados |
| `error` | servidor → cliente | Código y mensaje |

El cliente manda solo lo que el servidor no tiene, reintenta con espera
exponencial cuando se cae la red, y `whenSynced()` se resuelve cuando el
servidor confirmó todos los cambios locales.

## Cómo está hecho

- **Lista y texto:** RGA con identificadores de Lamport, sobre una secuencia
  dividida en bloques de 512 elementos. Insertar en un documento de cien mil
  caracteres no recorre todo el texto.
- **Entrega causal:** un cambio se aplica solo cuando ya llegaron los cambios
  de los que depende; mientras tanto espera en una cola.
- **Formato de cambio:** varints, tabla de autores por cambio y operaciones
  unidas cuando son escritura o borrado consecutivos.
- **Formato de guardado:** una tabla de autores para todo el documento,
  números como diferencias y rachas de pulsaciones. Al cargar se reconstruye
  cada cambio idéntico al original.
- **Historial en memoria:** un solo búfer contiguo, sin un objeto por cambio.

## Desarrollo

```sh
cd js && npm install && npm test
cd dart && dart pub get && dart test
cd server && go test -race ./...
node e2e/run.mjs
```

## Límites

- El historial crece para siempre. No hay compactación ni recolección de
  elementos borrados.
- Cargar un documento vuelve a aplicar todo su historial.
- En los mapas gana una sola escritura; no se exponen los valores en
  conflicto.
- Los índices de texto cuentan puntos de código Unicode, no unidades UTF-16
  ni grafemas.
- No hay texto enriquecido (negritas, enlaces) ni presencia de cursores.
- El servidor es un solo nodo con SQLite.

## Ecosistema

| Repo | Papel |
|---|---|
| [hallar](https://github.com/KlGamers/hallar) | Búsqueda semántica sin internet en el teléfono |
| [vecdex](https://github.com/KlGamers/vecdex) | Índice vectorial HNSW |
| [guardia](https://github.com/KlGamers/guardia) | Revisión antes de cada commit |
| [pulso](https://github.com/KlGamers/pulso) | Monitoreo del servidor autohospedado |

## Licencia

MIT. La traza de edición es de automerge-perf (MIT) y se descarga aparte.

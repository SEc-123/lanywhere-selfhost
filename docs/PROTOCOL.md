# Protocolo del servidor de salas (LANywhere)

Puerto **11460**: TCP para el control (salas, mensajes de búsqueda/unión) y UDP para los paquetes del juego.
Todos los enteros en **little-endian**.

## Salas y direcciones virtuales

- Una sala tiene un **código** de 6 caracteres (`A-Z` sin `I`/`O`, `2-9`), hasta **8 miembros** e índices 0..7.
- Las salas van en la red **10.13.0.0/16** (máscara 255.255.0.0), la misma de LAN Play: cada miembro recibe una IP
  única en todo el servidor (un emulador conserva la suya). Así consolas y emuladores ven las mismas direcciones,
  también las que el juego lleva dentro de sus paquetes. Broadcast: **10.13.255.255** (y 255.255.255.255 igual).
- Clientes antiguos (sin el byte de funciones en CREATE/JOIN): sus salas siguen en **10.114.0.(índice + 1)**/24,
  broadcast 10.114.0.255, sin cruzarse con LAN Play; no pueden entrar en salas 10.13 (ERROR 8).

## TCP (control)

Tramas: `u16 longitud` (del resto) · `u8 tipo` · cuerpo.

| Tipo | Sentido | Cuerpo |
|---|---|---|
| 0x01 CREATE | C→S | `u64 game_id` · `char nick[32]` · `u8 funciones` (opcional) |
| 0x02 JOIN | C→S | `char code[6]` · `char nick[32]` · `u64 game_id` (opcional) · `u8 funciones` (opcional) |
| 0x03 LEAVE | C→S | — |
| 0x04 RELAY | C→S | `u8 destino` (índice; 0xFF = todos los demás) · datos |
| 0x05 PING | C→S | — (cada 5 s; sin tráfico en 20 s el servidor cierra) |
| 0x06 RESUME | C→S | `u32 token` · `char[6] código` — vuelve al mismo puesto (índice, IP, token) tras un corte; se contesta con ROOM |
| 0x07 PUBLISH | C→S | NetworkInfo de ldn (0x480 bytes) del grupo del anfitrión; vacío lo retira |
| 0x08 FIND | C→S | `u64 id del juego` (0 = todos); no hace falta estar en una sala |
| 0x87 GROUPS | S→C | `u8 n` · n × (`char[6] código` · NetworkInfo): grupos abiertos con sitio, hasta 6 |
| 0x81 ROOM | S→C | `char code[6]` · `u8 mi_índice` · `u32 mi_ip` · `u32 token` · `u64 game_id` · `u8 n` · n × miembro |
| 0x82 MEMBER_JOINED | S→C | miembro |
| 0x83 MEMBER_LEFT | S→C | `u8 índice` |
| 0x84 RELAY | S→C | `u8 origen` · datos |
| 0x85 ERROR | S→C | `u8 código` (1 sala no existe, 2 sala llena, 3 juego distinto, 4 petición no válida, 5 el puesto de RESUME ya no existe, 6 servidor en pausa por el tope mensual de tráfico, 7 demasiadas peticiones, 8 hay que actualizar el cliente) · texto |
| 0x86 PONG | S→C | — |

Miembro: `u8 índice` · `u32 ip` · `char nick[32]`.

`game_id` es el identificador de comunicación local del juego: al unirse, el servidor comprueba que coincide con
el de la sala (no se mezclan juegos distintos). Con `game_id` 0 en el JOIN no se comprueba.

`funciones` (bit 0): el cliente entiende la red 10.13.0.0/16. Lo manda el sysmodule actual; la sala toma el del CREATE.

## UDP (datos)

Datagramas: `u32 magic 0x594E414C ("LANY")` · `u8 tipo` · cuerpo.

| Tipo | Sentido | Cuerpo |
|---|---|---|
| 0x01 REGISTER | C→S | `u32 token` (el de ROOM; repetir hasta recibir REGISTERED) |
| 0x02 DATA | C→S | `u32 token` · `u32 ip_destino` · `u16 puerto_origen` · `u16 puerto_destino` · carga |
| 0x03 KEEPALIVE | C→S | `u32 token` (cada 5 s: mantiene abierta la traducción NAT del router) |
| 0x81 REGISTERED | S→C | — |
| 0x82 DATA | S→C | `u32 ip_origen` · `u16 puerto_origen` · `u16 puerto_destino` · carga |

- El servidor identifica al remitente por el `token`, no por su dirección: si el router cambia el puerto
  público, el siguiente REGISTER/KEEPALIVE/DATA actualiza la dirección.
- DATA a una IP de miembro se reenvía solo a ese miembro; a broadcast, a todos los demás miembros registrados.
- Carga máxima: 1472 bytes (un datagrama UDP con MTU 1500, como en una LAN). Con las cabeceras, un DATA grande pasa de
  1500 bytes y viaja fragmentado: el cortafuegos del proveedor debe dejar pasar los fragmentos UDP (ver el README).

## Cortes de conexión

Si la conexión TCP se cierra sin LEAVE, el servidor guarda el puesto del miembro 60 s (los demás no reciben
MEMBER_LEFT). La consola reintenta RESUME cada 2 s durante 55 s y vuelve a registrar su UDP. Pasa, por ejemplo,
cuando el juego activa el modo inalámbrico local y la consola reconecta el Wi-Fi.

## Control de ldn por RELAY

Con una sala activa, ldn_mitm no usa broadcast UDP ni TCP en la red local: manda sus mensajes con RELAY como
`u8 LdnMsg` · datos. 1 SCAN (a todos), 2 SCAN_RESP (NetworkInfo, 0x480 bytes), 3 CONNECT (NodeInfo, 0x40),
4 SYNC (NetworkInfo, del anfitrión a cada estación), 5 DISCONNECT. Las IP de los nodos son las virtuales de la sala.

## Grupos abiertos

Si la consola no está en una sala privada, **crear grupo** en el juego crea una sala nueva (con el id del juego) y
publica el grupo con PUBLISH cada vez que cambia. **Buscar grupo** hace FIND con el id del juego (además del broadcast
en la red local) y muestra esos grupos en el menú del juego; **unirse** a uno hace JOIN con su código y luego CONNECT.
Al cerrar o dejar el grupo, la consola sale de la sala. `public=0` en `sdmc:/lanywhere/config.ini` lo desactiva.

## Pasarela LAN Play (emuladores)

En **UDP 11451** el servidor habla el protocolo de switch-lan-play (`u8 tipo` · cuerpo: 0 keepalive, 1 IPv4,
2 ping, 3 fragmento IPv4), el que usa Ryujinx en su modo "LAN Play". Dentro viaja el modo local de ldn_mitm en LAN:
búsqueda por broadcast UDP al 11452, unión por TCP al 11452 del anfitrión y los paquetes del juego por UDP. La
pasarela (`server/relay/lanplay.js`):

- Reenvía entre emuladores como un servidor de LAN Play normal, por la IP de destino.
- Responde a la búsqueda de un emulador con los grupos abiertos de consolas (salas 10.13); al unirse, el emulador
  entra en la sala como un miembro virtual con su propia IP.
- Pregunta cada 3 s a los emuladores si tienen grupo y publica los que encuentra como grupos abiertos; una consola
  que se une llega al emulador por una conexión TCP que abre la pasarela en su nombre.
- Responde al ping (ICMP) en las IPs de las consolas, para que un emulador no elija una IP ocupada.
- Reensambla los fragmentos IP y de LAN Play que van a una consola, y parte en fragmentos IP los paquetes de más de
  1400 bytes que construye para un emulador.

## Seguridad y límites del servidor

- **Apodos:** el nombre en la sala es el apodo de `config.ini` (`apodo=`; el sysmodule crea uno al azar), nunca el
  nombre de usuario de la consola. El servidor lo limpia (letras, números, espacio, `. _ -`; 2 a 20 caracteres; filtro de
  palabras ofensivas → "Jugador NNNN") y reescribe con esos apodos los nombres de los nodos de todo NetworkInfo que
  pasa por él (PUBLISH, SCAN_RESP y SYNC).
- **UDP:** solo se acepta desde la misma IP pública que la conexión TCP del miembro (evita la reflexión con un token
  adivinado o capturado).
- **Límites por IP:** 12 conexiones; por minuto, 10 CREATE, 30 JOIN/RESUME y 120 FIND. Máximo 3000 salas.
- **Tope mensual de tráfico de salida** (`LANYWHERE_CAP_GB`, 8000 por defecto): se cuenta
  todo lo enviado (con cabeceras) y se guarda en `LANYWHERE_STATE_DIR/traffic.json`; al superarlo el servidor responde
  ERROR 6 y deja de reenviar hasta el día 1 del mes siguiente (UTC).

## Self-host 0.4 extension: reserved matching and paged discovery

All integers below are little-endian. TCP framing is unchanged (`u16 length`, `u8 type`, body). The client checks
capabilities before using extensions. Unknown capability bits are ignored; a relay without matching support must
not silently turn a Quick/Exact selection into an unrestricted search.

| Type | Direction | Body |
| --- | --- | --- |
| `0x09 RESERVE` | C→S | 122 bytes, described below |
| `0x0a CANCEL` | C→S | 16-byte ticket |
| `0x0b CAPS` | C→S | Empty |
| `0x0c FIND_PAGE` | C→S | `u64 LCID` (`0` = all games), `u32 offset` |
| `0x88 RESERVATION` | S→C | `u8 state`, `u32 remaining_ms`; only state 1 appends code[6] + NetworkInfo[0x480] |
| `0x89 CAPABILITIES` | S→C | `u32 flags`; bits 0/1 = reservations/paged discovery. See [UDP-V2](UDP-V2.md) and the provider/metadata notes for later bits. |
| `0x8a PAGE` | S→C | `u32 next_offset`, `u8 count`, at most 6 × (code[6] + NetworkInfo[0x480]) |

`RESERVE` offsets:

| Offset | Bytes | Meaning |
| --- | --- | --- |
| 0 | 16 | Client-generated random nonzero ticket; reused for retries of the same intent |
| 16 | 96 | Canonical native ScanFilter, zeroing unspecified/reserved fields |
| 112 | 1 | Whether actual local communication version is known (0 or 1) |
| 113 | 2 | Local communication version, only used if known |
| 115 | 1 | Feature bits; bit 0 permits virtual `10.13.0.0/16` addresses |
| 116 | 6 | Exact room code, or six zero bytes for Quick match |

The filter's LCID flag must be set and its LCID must be nonzero. Optional native flags are session, network type,
SSID and scene. The ScanFilter has **no communication-version field**. A first scan may therefore reserve an offer
provisionally; the real game's Connect version is required before claiming its seat. This is not a claim that all
game updates/DLC/protocols are compatible.

Within the 96-byte ScanFilter the offsets are LCID 0, scene 10, session 16, network type 32, SSID length 42,
SSID bytes 43, and flags 92. The supported flag bits are LCID `0x01`, session `0x02`, network type `0x04`, SSID
`0x10`, and scene `0x20`. This matches the filters used by this sysmodule's native Scan implementation.

States are 0 waiting, 1 assigned, 2 closed/expired/canceled, and 3 already joined. Waiting tickets are considered in
FIFO order within each game's queue, skipping currently incompatible entries. Eligible rooms are real, active,
published native rooms. The fullest eligible room is chosen first, with code as a deterministic tie-breaker.
Room capacity counts both actual members and outstanding reservations. The optional emulator gateway does not
offer reserved matching because it cannot enforce admission on an emulator's own LAN listener.

A reserved `JOIN` has **65 bytes**: the existing 47-byte JOIN followed by ticket[16] at offset 47 and the actual
`u16 localCommunicationVersion` at offset 63. The server validates the ticket, source address, selected group
identity, capacity and actual version before atomically consuming the hold. `ERROR 9` means a version mismatch.
A retry on the same live TCP session is idempotent; after a dropped response, another connection can resume the
same claimed member only after the earlier TCP session has detached. It cannot replace another live session.

Polling the same ticket does not extend its deadline or change its filters/target. Requests are bound to their
original TCP source IP; a source IP change before admission requires a fresh ticket. Cancellation retains a bounded
tombstone so a delayed request cannot resurrect the same ticket. Cancelling a claimed ticket does not replace
the normal member `LEAVE`. Default server wait is 90 seconds, hold is 30 seconds, and the native client stops its search after 45
seconds (90 seconds to open a game before the first scan). A new attempt uses a new ticket. Queue and hold state
is transient; a server restart does not preserve a game session or match.

Limits include 4096 retained tickets globally, 256 waiting per LCID, 8 active and 32 retained per source IP, and 600 RESERVE/CANCEL
requests per minute per IP. These limits accommodate several consoles behind one NAT but do not replace player
authentication or encrypted transport. Both TCP control (including tickets) and UDP gameplay use the existing
plaintext transport.

`FIND_PAGE` is a live view, ordered by LCID, then advertised occupancy descending, then code. `0xffffffff` means
end. An out-of-range cursor returns an empty terminal page; it never wraps to page 0. Rooms can move between
pages as the lobby changes, so clients retain selection by **LCID + room code**, not by row index. Exact selection
never falls back to another room if the selected code disappears, is incompatible or expires.

## App/sysmodule IPC ABI 5

The service is `lanywhr`. Legacy command IDs 0–5 remain; command 6 selects a strict exact room (empty clears it).
The app checks command 10 before normal operations and shows an update/reboot screen for an incompatible module.

| ID | Method | Inputs / outputs |
| --- | --- | --- |
| 7 | StartQuickMatch | No input |
| 8 | CancelMatch | No input |
| 9 | GetMatchStatus | 88-byte status |
| 10 | GetProtocolCapabilities | `u32` ABI major, currently 5 |
| 11 | ListGroupsPage | Legacy: `u32 offset`; output `{s32 count, u32 next}` and 64-byte GroupSummary buffer |
| 12 | ListGroupsV2 | `u32 offset`; output `{s32 count, u32 next, u32 capabilities, u32 reserved}` and 336-byte GroupSummaryV2 buffer |

GroupSummaryV2 uses `code[8]` at offset 0, `u64 LCID` at 8, `u64 application_id` at 16, `u64 program_id` at 24,
`u8 players/max_players/metadata_flags` at 32–34, `host[40]` at 40, and `title_en[128]` / `title_zh[128]` at
80 / 208. Metadata flag 1 is a host declaration; flag 2 is a local LCID candidate and must not be presented as a
verified remote title. IDs and titles received from other clients are untrusted. The app checks local NS installation
and NACP LCID before a user-triggered launch. Missing/ambiguous names retain an LCID-based Unknown fallback.

MatchStatus is `u64 game_id`, `u32 ttl_seconds`, four `u8` fields (mode, state,
players, capacity), room[8], error[64]. Modes are Manual=0, Quick=1, Exact=2. States are Idle=0, WaitingForGame=1,
Searching=2, Assigned=3, Joining=4, Joined=5, Expired=6, Cancelled=7, Error=8. The matching worker only offers
compatible discovery results: the actual game must still call Scan/Connect, create its own hosted group and
decide when gameplay begins. It cannot synthesize a game host, force a menu refresh, or start a round.


## Version 0.4.2 extensions

See [UDP v2 and filtered discovery](UDP-V2.md) for the negotiated fragmentation, nonce heartbeat, replay bounds, and complete ScanFilter wire contract.

## Appointments (self network)

TCP frame `0x26` takes the 56-byte little-endian `AppointmentRequest` and replies with `0xa6`
containing a 264-byte `AppointmentResponse`. Layouts and statuses are defined in
`common/appointments.h`. Operations are list (1), create (2), ready (3) and cancel ready (4).
A duplicate game/edition/start-minute create returns the existing appointment list. The
saved record contains only its random event ID, UTC start, local communication ID and
application ID.

Ready is available from 30 minutes before the start through two hours after it. The server
uses a per-boot opaque nonce to count at most one five-minute lease per console. The nonce,
lease and counts are transient. A successful Ready response starts its page with the
matching appointment.

Switch IPC 13 exchanges appointment frames. IPC 14 lists ordinary self-network public
rooms for one local communication ID. IPC 15/16 set and read a single console-local alert.
The legacy single alert is cleared on reboot. Joined and Ready alerts expire two
hours after the start and use the Ultrahand notification API.

IPC 22 reads locally joined appointment IDs. IPC 23 joins or leaves an appointment
on this console, up to 24 saved appointments. Joined events can arm room alerts
across reboots. Listing, creation, and readiness use the configured self-hosted
endpoint independently of the selected game network. IPC 26 reads the local alert status.

Self capability `4096` supports an appointment alert stream. The client sends
`0x29` on a dedicated TCP connection with a 208-byte `AppointmentPushSubscriptions`
body. It can include the 24 saved appointments and a separate Ready watch.
After subscribing, the connection accepts replacement subscriptions and PING.
The relay acknowledges with `0xa9` and sends eligible room events, including
currently joinable rooms when reconnecting.

A `0xa9` body contains the relay time, appointment ID, and delivery ID as three
little-endian u64 values followed by one 336-byte room summary. Both IDs and
the room are zero on acknowledgment. The relay uses its own time for the
reminder window and keeps a delivery ID stable while a room remains joinable.
A room that becomes joinable again gets a new ID. The device uses relay time
and its monotonic clock to keep the appointment window independent of the
console date. Relays without capability `4096` use the existing room lookup.

A capable self relay accepts an optional little-endian appointment ID after the
ordinary `0x07` room advertisement. LANywhere supplies it for a host that
marked Ready for a matching appointment. The relay validates the game and
appointment window. A linked room alerts that appointment. Unlinked public
rooms are eligible by matching game.

## Game room access (self network)

Capability `512` supports password sharing. Capability `1024` adds a hidden password
and an inclusive lobby view. The root self-hosted relay advertises these flags.
Other networks retain their own room policies.

A metadata page request with a thirteenth byte of 1 lists published game rooms,
including full and password-protected rooms. Rows are still 336 bytes. Byte 35
holds the password mode (0 none, 1 shared, 2 hidden). Legacy discovery and automatic
matching exclude hidden rooms. The in-game host still controls its own game policy.

TCP frame `0x27` exchanges a 48-byte request for a 32-byte response in frame `0xa7`.
Layouts are in `common/room_passcode.h`. The request names the exact relay room
and game ID. The host can share, hide, or clear the password using its live room
token and current network address. A lookup for a hidden password returns status
6 with no password bytes. A wrong entry returns status 7.

A correct entry grants short-lived exact-match access. The guest appends the
16-byte grant to the ordinary 122-byte reservation request. The relay checks it
before assigning or admitting the guest. Password or session changes invalidate
outstanding access. Legacy direct joins cannot enter a protected room. Players
already admitted can use normal reconnection. Passwords and grants stay in memory.

Switch IPC 17–19 retain their sharing/lookup/host roles. IPC 20 sets visibility and
password together. IPC 21 checks the submitted password and arms the exact match.

## Unified lobby

Root capability `2048` enables a read-only lobby across the self network and the
enabled upstream networks. Frame `0x28` takes `u32 offset, u32 snapshot`. Snapshot
zero starts a fresh view. Reply `0xa8` carries `u32 snapshot, u32 next, u8 count,
u8 available, u8 total, u8 status`, then up to six rows. Status 1 means that the
snapshot has expired. Start again at offset zero.

Each 376-byte row contains the ordinary 336-byte summary, the NUL-terminated
provider ID in 33 bytes, and seven zero bytes. A room is identified by provider,
LCID and its six-byte code. The server shares one discovery cache across clients.
The source counts distinguish an empty result from an incomplete search.

IPC 24 reads these rows. IPC 25 selects a provider-qualified room for the next
in-game search. The relay connection retains that provider for the active room
and reconnects on the same route. New game rooms use the self network.

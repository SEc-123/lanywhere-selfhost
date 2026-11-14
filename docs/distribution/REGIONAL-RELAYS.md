# Community and regional connections

## Public LANywhere

The lobby and appointments stay on the configured server. With **Community · LANywhere** selected, the Switch hosts in the game’s Local Wireless mode. Guests select that room from the same lobby and search in the game. Both consoles send gameplay to the public LANywhere endpoint directly. Use the in-game password when the game requires one. Appointment alerts and lobby password sharing use My server.

To enable this line on the directory server, set `LANYWHERE_ENABLE_PUBLIC_UPSTREAM=1` and `LANYWHERE_ENABLE_COMMUNITY_DIRECT=1`. The built-in `lanywhere-public` destination and the client’s `RELAY_PROFILE_COMMUNITY_IPV4/PORT` must agree. The lobby offers the line after a successful directory refresh. The default hosting line is My server. Each active game stays on the endpoint where it started.

Check that the public operator allows use by your client and that TCP and UDP reach the endpoint from both players’ networks. Verify actual hosting, joining, gameplay and reconnect on two Switch consoles before enabling it for players. The upstream listing returns up to six rooms per query. The original node uses legacy game UDP up to 1472 bytes per datagram and lacks the self-host game TCP extension. Use My server for games that need those extensions.

Switch LAN Play room sources continue to use the existing gateway adapter. Their IPv4-over-UDP and LDN game traffic require a separate client-side transport to run directly from a Switch.

## Optional self-managed regional connections

A regional build lets players choose China or Europe before hosting. The unified lobby lists open rooms from both relays. Choosing a room connects gameplay directly to its relay, including the room's access check, join and reconnection. A guest can keep a different region for the next room they host.

The default release profile uses China. Europe appears when the client build includes the Europe endpoint. The central server provides the regional room directory. The Europe server operates its own rooms, reservations, and game traffic. Configure both before distributing the regional build.

## Configure the nodes

1. Run the standard relay on an authorized Europe server. Expose its game port over TCP and UDP. Keep its state directory separate from the central relay state.
2. Set `LANYWHERE_EU_RELAY=IPV4:PORT` in the central relay's environment using the Europe server's reachable address. The central relay reads that server's public room metadata.
3. Set the same IPv4 and port in `RELAY_PROFILE_EU_IPV4` and `RELAY_PROFILE_EU_PORT` in `common/relay_profile.h`. Rebuild the Album app and sysmodule together via the normal embedded build.
4. Check the SD ZIP's app, sysmodule and overlay versions, and verify that a room created on Europe is visible in the new unified lobby. The Switch checks that the regional address advertised by the directory matches its configured endpoint.

Legacy clients use the earlier room list and continue to see their existing sources.

Appointments and appointment reminders use the central server. A room hosted in Europe appears in the main lobby. It does not generate a central appointment reminder. Use a central room if the appointment group relies on the reminder.

## Validate before enabling Europe

- Run the repository's host tests. With two independent relays, create rooms on each, confirm they appear with the correct source, and select a Europe room with the hosting preference set to China. Check that game traffic arrives on Europe and a connection loss resumes at the same node.
- Confirm public TCP and UDP reachability from both players. Compare RTT, jitter and loss for each player to both nodes, then compare actual gameplay with the same game and version.
- Check the workflows with a password-protected room, a region change while idle, and a connection in progress. Reboot and confirm the default is China. Regional selection is kept until the module restarts.
- Test on two physical Switch consoles before documenting gameplay or latency as verified for a specific region.

The central directory aggregates room listings. It does not forward game traffic between regional relays. Each room uses one relay.

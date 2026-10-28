// Entry-point shim for panels that hardcode `node index.js`.
// A Pterodactyl/Pelican "Node.js" egg typically starts MAIN_FILE=index.js
// and won't let the user edit the startup command. This keeps that default
// working without touching bot.js.
import './bot.js';

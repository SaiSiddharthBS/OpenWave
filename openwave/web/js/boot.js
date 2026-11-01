// Starts OpenWave. Served by an OpenWave engine, it loads the app straight away; as the web app on
// the OpenWave website it first connects to the paired computer (remote.js).
import { REMOTE, boot } from './remote.js';

if (REMOTE) await boot();
await import('./app.js');

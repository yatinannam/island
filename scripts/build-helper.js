// Compiles media/smtc.cs to media/bin/smtc.exe so the installer can ship it.
const { build } = require('../media/helper');

build()
  .then((exe) => console.log(`built ${exe}`))
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });

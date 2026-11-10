// Compiles the C# helpers so the installer can ship them:
// media/smtc.cs -> media/bin/smtc.exe, activity/islandctl.cs -> activity/bin/islandctl.exe
const media = require('../media/helper');
const activity = require('../activity/helper');

Promise.all([media.build(), activity.build()])
  .then((exes) => exes.forEach((exe) => console.log(`built ${exe}`)))
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });

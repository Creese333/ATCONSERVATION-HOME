# @Conservation

**[atconservation.com](https://atconservation.com)**: the @Conservation home page. A 3D model of the Appalachian Trail at Harpers Ferry, the camera slowly circling, with the spotted lanternfly records (the forest pest records ACT animates) appearing year by year, and a button to **ACT - Appalachian Conservation Tool** at [act.atconservation.com](https://act.atconservation.com) (repo Creese333/ATCONSERVATION).

| File | What it is |
|---|---|
| `index.html` | The page |
| `atmap.js` | The map engine, copied from ACT (MapLibre GL JS 5.24.0, terrain, imagery, the basemap tile queue). Copy it again from ATCONSERVATION when ACT's changes |
| `images/` | Icons |
| `CNAME` | `atconservation.com` |

The records are read from `https://grid.trailassessment.org/data/phen/lycorma-delicatula.json` (built in Creese333/AT-Resource-Grid); the trail line from the NPS ANST_Centerline service. `data/`, `scripts/` and `.github/workflows/` hold only a note each, so the folders exist for uploads.

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IdMap = void 0;
exports.parseTable = parseTable;
exports.datelineToDate = datelineToDate;
exports.classifyOrg = classifyOrg;
/**
 * Kayako Classic → 23 Telecom importer (idempotent, re-runnable).
 *
 *   tsx scripts/import-kayako.ts <dump.sql> [--inventory <tables_inventory.csv>]
 *
 * Run AFTER `npm run seed` (it imports ON TOP of the seeded reference data and
 * resolves status/priority/type/department by title, never by Kayako id).
 *
 * Design (per docs/GOAL_MIGRATION.md):
 *  - Parse raw MySQL `INSERT INTO ... VALUES (...),(...)` statements (the dump is
 *    a mysqldump). Build per-table row arrays keyed by column name.
 *  - Keep an oldKayakoId → newId map per table; resolve FKs in dependency order.
 *  - Upsert by a stored `kayakoId` so a re-run changes nothing.
 *  - Detect full-dump vs the sampled subset and log imported-vs-expected counts.
 *
 * M0 implements the parser + framework + Organization import (the pipeline proof
 * + orgType classification). swusers/emails/notes land in M1; macros in M4.
 */
const node_fs_1 = require("node:fs");
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
/** Split one VALUES body "(...),(...)" into raw tuple strings (quote/escape aware). */
function splitTuples(body) {
    const tuples = [];
    let depth = 0;
    let cur = '';
    let inQuote = false;
    let esc = false;
    for (const ch of body) {
        if (esc) {
            cur += ch;
            esc = false;
            continue;
        }
        if (ch === '\\') {
            cur += ch;
            esc = true;
            continue;
        }
        if (ch === "'") {
            inQuote = !inQuote;
            cur += ch;
            continue;
        }
        if (!inQuote && ch === '(') {
            depth++;
            if (depth === 1)
                continue; // drop the outer paren
        }
        if (!inQuote && ch === ')') {
            depth--;
            if (depth === 0) {
                tuples.push(cur);
                cur = '';
                continue;
            }
        }
        if (depth >= 1)
            cur += ch;
    }
    return tuples;
}
/** Split one tuple "1,'a','b\\'c',NULL" into typed string|null values. */
function splitValues(tuple) {
    const vals = [];
    let cur = '';
    let inQuote = false;
    let esc = false;
    let quoted = false;
    for (const ch of tuple) {
        if (esc) {
            cur += ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : ch;
            esc = false;
            continue;
        }
        if (ch === '\\') {
            esc = true;
            continue;
        }
        if (ch === "'") {
            inQuote = !inQuote;
            quoted = true;
            continue;
        }
        if (ch === ',' && !inQuote) {
            vals.push(quoted ? cur : cur.trim() === 'NULL' ? null : cur.trim());
            cur = '';
            quoted = false;
            continue;
        }
        cur += ch;
    }
    vals.push(quoted ? cur : cur.trim() === 'NULL' ? null : cur.trim());
    return vals;
}
/** Parse all INSERT rows for a given Kayako table from the dump text. */
function parseTable(sql, table) {
    const out = { columns: [], rows: [] };
    // A table may be split across several INSERT statements.
    const re = new RegExp('INSERT INTO `' + table + '`\\s*(?:\\(([^)]*)\\))?\\s*VALUES\\s*(.*?);\\s*(?:\\n|$)', 'gis');
    let m;
    while ((m = re.exec(sql)) !== null) {
        if (m[1] && out.columns.length === 0) {
            out.columns = m[1].split(',').map((c) => c.trim().replace(/`/g, ''));
        }
        for (const tup of splitTuples(m[2])) {
            const vals = splitValues(tup);
            const row = {};
            out.columns.forEach((col, i) => (row[col] = vals[i] ?? null));
            out.rows.push(row);
        }
    }
    return out;
}
// ─────────────────────────── helpers ───────────────────────────
/** Kayako stores timestamps as unix seconds; 0 means "unset". */
function datelineToDate(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date();
}
/** oldKayakoId → newDbId map per table, for FK resolution across the import. */
class IdMap {
    maps = new Map();
    set(table, oldId, newId) {
        if (!this.maps.has(table))
            this.maps.set(table, new Map());
        this.maps.get(table).set(oldId, newId);
    }
    get(table, oldId) {
        if (oldId == null)
            return undefined;
        return this.maps.get(table)?.get(oldId);
    }
}
exports.IdMap = IdMap;
/**
 * Classify a Kayako organization. Kayako has no client/supplier flag — 23T's
 * "to customer"/"to vendor" macro split confirms the model. 23 Telecom itself is
 * INTERNAL; known carriers are SUPPLIER; everyone else is a CLIENT.
 */
const SUPPLIER_NAMES = ['lleida', 'broadnet', 'sinch', 'nrs gateway', 'nrs', 'tele2', 'horisen'];
function classifyOrg(name) {
    const n = name.trim().toLowerCase();
    if (n === '23 telecom' || n.startsWith('23telecom') || n.includes('23 telecom'))
        return 'INTERNAL';
    if (SUPPLIER_NAMES.some((s) => n.includes(s)))
        return 'SUPPLIER';
    return 'CLIENT';
}
// ─────────────────────────── importers ───────────────────────────
async function importOrganizations(parsed, ids) {
    const summary = [];
    for (const row of parsed.rows) {
        const kayakoId = Number(row['userorganizationid']);
        const name = row['organizationname'] ?? `Org ${kayakoId}`;
        const orgType = classifyOrg(name);
        const data = {
            orgType,
            name,
            address: row['address'] ?? '',
            city: row['city'] ?? '',
            state: row['state'] ?? '',
            postalCode: row['postalcode'] ?? '',
            country: row['country'] ?? '',
            phone: row['phone'] ?? '',
            website: row['website'] ?? '',
            createdAt: datelineToDate(row['dateline'] ?? null),
        };
        const org = await prisma.organization.upsert({
            where: { kayakoId },
            create: { kayakoId, ...data },
            update: data,
        });
        ids.set('swuserorganizations', kayakoId, org.id);
        summary.push({ kayakoId, name, orgType });
    }
    // The goal asks us to PRINT the org list with chosen orgType for human confirmation.
    console.log('\n=== Organizations (confirm orgType) ===');
    for (const s of summary) {
        console.log(`  [${s.orgType.padEnd(8)}] kayakoId=${s.kayakoId}  ${s.name}`);
    }
}
// ─────────────────────────── runner ───────────────────────────
const DEPENDENCY_ORDER = [
    'swuserorganizations', // → Organization      (M0/M1)
    'swusers', // → User                          (M1)
    'swuseremails', // → UserEmail                (M1)
    'swusernotes', // → user notes                (M1)
    'swemailqueues', // → EmailQueue              (M2)
    'swparserrules', // → EmailParserRule         (M2)
    'swmacrocategories', // → MacroCategory        (M4)
    'swmacroreplies', // → Macro                  (M4)
];
async function main() {
    const dumpPath = process.argv[2];
    if (!dumpPath || !(0, node_fs_1.existsSync)(dumpPath)) {
        console.error('Usage: tsx scripts/import-kayako.ts <dump.sql> [--inventory <csv>]');
        process.exit(1);
    }
    const invFlag = process.argv.indexOf('--inventory');
    const invPath = invFlag > -1 ? process.argv[invFlag + 1] : undefined;
    const sql = (0, node_fs_1.readFileSync)(dumpPath, 'utf8');
    const ids = new IdMap();
    // Expected row counts (full-dump detection).
    const expected = new Map();
    if (invPath && (0, node_fs_1.existsSync)(invPath)) {
        for (const line of (0, node_fs_1.readFileSync)(invPath, 'utf8').split('\n').slice(1)) {
            const [t, c] = line.split(',');
            if (t)
                expected.set(t.trim(), Number(c));
        }
    }
    console.log(`Importing from ${dumpPath}`);
    let sampled = false;
    for (const table of DEPENDENCY_ORDER) {
        const parsed = parseTable(sql, table);
        const exp = expected.get(table);
        const note = exp != null ? ` (dump has ${parsed.rows.length}/${exp} expected)` : '';
        if (exp != null && parsed.rows.length < exp)
            sampled = true;
        console.log(`• ${table}: parsed ${parsed.rows.length} rows${note}`);
        if (table === 'swuserorganizations' && parsed.rows.length) {
            await importOrganizations(parsed, ids);
        }
        // swusers/emails/notes → M1; queues/parser → M2; macros → M4.
    }
    if (sampled) {
        console.log('\n⚠️  SAMPLED DUMP DETECTED — at least one table has fewer rows than the inventory expects.\n' +
            '    A full mysqldump is required to migrate ALL clients/suppliers/users/macros.\n' +
            '    Imported the available subset; missing rows are logged above.');
    }
    console.log('\n✅ Import run complete.');
}
// Only run when invoked directly (so the parser can be unit-tested on import).
if (require.main === module) {
    main()
        .catch((e) => {
        console.error(e);
        process.exit(1);
    })
        .finally(() => void prisma.$disconnect());
}
//# sourceMappingURL=import-kayako.js.map
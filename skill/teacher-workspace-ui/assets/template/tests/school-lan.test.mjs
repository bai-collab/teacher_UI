import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {addressKind, listInterfaces, makeConfig, saveConfig, readConfig, osepLaunchPlan, launchOsep, main} from '../scripts/school-lan.mjs';
const ip = '163.27.8.9'; // Synthetic school-style address; never bound or contacted.
const nic = (address, internal = false) => ({address, family: 'IPv4', internal});
const interfaces = {Ethernet: [nic(ip)], WiFi: [nic('192.168.8.9')], vEthernet: [nic('172.24.8.9')],
    Loopback: [nic('127.0.0.1', true)]};

test('explicit school public IPv4, multiple NICs and excluded addresses', () => {
    assert.equal(addressKind(ip), 'public'); assert.equal(makeConfig({ip}, interfaces).ip, ip);
    assert.equal(makeConfig({ip: '192.168.8.9'}, interfaces).interfaceName, 'WiFi');
    assert.equal(listInterfaces(interfaces).find(x => x.name === 'vEthernet').usable, false);
    for (const bad of [undefined, '0.0.0.0', '127.0.0.1', '169.254.1.2', '100.64.1.2', '224.0.0.1', '255.255.255.255',
        '::1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '198.18.1.2', '163.027.8.9', '172.24.8.9', '10.9.9.9']) {
        assert.throws(() => makeConfig({ip: bad}, interfaces));
    }
    assert.throws(() => makeConfig({ip}, {...interfaces, VPN: [nic(ip)]}), /LAN_INTERFACE_UNAVAILABLE/);
    for (const port of [0, 1023, 65536, 8612.5, '8612', NaN]) assert.throws(() => makeConfig({ip, port}, interfaces), /INVALID_PORT/);
});
test('create-only settings, current interface recheck, no teacher LAN scope', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teacher-lan-')); t.after(() => fs.rm(dir, {recursive: true, force: true}));
    const file = path.join(dir, 'local-data', 'lan.json'), config = makeConfig({ip}, interfaces);
    await saveConfig(file, config); assert.deepEqual(await readConfig(file, interfaces), config);
    await assert.rejects(saveConfig(file, {...config, port: 8700}), {code: 'EEXIST'});
    assert.deepEqual(await readConfig(file, interfaces), config);
    await assert.rejects(readConfig(file, {Other: [nic(ip)]}), /LAN_INTERFACE_CHANGED/);
    await assert.rejects(readConfig(file, {Ethernet: [nic('10.2.3.4')]}), /LAN_INTERFACE_UNAVAILABLE/);
    for (const value of [{...config, access: 'teacher'}, {...config, aiKey: 'not-a-real-key'}, {...config, version: 2}]) {
        const bad = path.join(dir, 'bad.json'); await fs.writeFile(bad, JSON.stringify(value));
        await assert.rejects(readConfig(bad, interfaces), /INVALID_LAN_CONFIG/);
    }
});
test('adapter starts existing Node entry, forwards bounded LAN environment and child failure', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teacher-lan-launch-')); t.after(() => fs.rm(dir, {recursive: true, force: true}));
    const project = path.join(dir, 'project with spaces'), configFile = path.join(dir, 'lan.json');
    await saveConfig(configFile, makeConfig({ip, port: 8700}, interfaces));
    await assert.rejects(osepLaunchPlan({project, config: configFile}, interfaces), {code: 'ENOENT'});
    await fs.mkdir(path.join(project, 'scripts', 'tutor'), {recursive: true}); await fs.mkdir(path.join(project, 'build'));
    await fs.writeFile(path.join(project, 'build', 'editor.html'), '<!doctype html>');
    const script = path.join(project, 'scripts', 'tutor', 'server.mjs');
    await fs.writeFile(script, `import fs from 'node:fs'; fs.writeFileSync('observed.json', JSON.stringify({
        mode:process.env.TUTOR_LAN, ip:process.env.TUTOR_LAN_IP, port:process.env.TUTOR_PORT})); process.exit(7);`);
    const plan = await osepLaunchPlan({project, config: configFile}, interfaces);
    assert.deepEqual(plan.argv, [script]); assert.equal(plan.teacherUrl, 'http://127.0.0.1:8700/teacher.html');
    assert.equal(plan.studentUrl, `http://${ip}:8700/editor.html`); assert.equal(await launchOsep(plan), 7);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(project, 'observed.json'), 'utf8')), {mode: '1', ip, port: '8700'});
    await assert.rejects(osepLaunchPlan({project, config: configFile}, {Ethernet: [nic('10.2.3.4')]}), /LAN_INTERFACE_UNAVAILABLE/);
    await assert.rejects(main(['list', '--ip', ip]), /INVALID_COMMAND/);
    await assert.rejects(main(['configure', '--ip', ip, '--port', '8e3']), /INVALID_PORT/);
});

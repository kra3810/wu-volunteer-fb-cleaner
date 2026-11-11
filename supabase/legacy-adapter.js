/* Supabase adapter for the legacy Firebase-style room API.
 * Keeps existing db.ref(...).set/remove/once/on calls working during migration.
 */
(function () {
  const SECTION_NAMES = new Set(['allFilesData', 'fileScores', 'rawThreadsData', 'modeMemory', 'focus', 'cursors']);
  const META_FIELDS = new Set(['name', 'createdAt', 'lastUpdated', 'isDeleted']);

  function snapshot(value, exists = value !== null && value !== undefined) {
    return { exists: () => exists, val: () => value == null ? null : value };
  }

  function createSupabaseRoomAdapter(client) {
    const listeners = new Map();
    const disconnectHandlers = new Map();

    async function readRoom(code) {
      const [{ data: room, error: roomError }, { data: rows, error: dataError }] = await Promise.all([
        client.from('rooms').select('*').eq('code', code).maybeSingle(),
        client.from('room_data').select('section,data').eq('room_code', code)
      ]);
      if (roomError) throw roomError;
      if (dataError) throw dataError;
      if (!room) return null;
      const result = {};
      for (const row of rows || []) result[row.section] = row.data || {};
      return result;
    }

    async function readMeta(code) {
      const { data, error } = await client.from('rooms').select('*').eq('code', code).maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return {
        name: data.name,
        createdAt: new Date(data.created_at).getTime(),
        lastUpdated: new Date(data.last_updated).getTime(),
        ...(data.is_deleted ? { isDeleted: true } : {})
      };
    }

    async function readPath(path) {
      const p = path.split('/').filter(Boolean);
      if (!p.length) return null;
      if (p[0] === 'rooms_meta') {
        if (p.length === 1) {
          const { data, error } = await client.from('rooms').select('*');
          if (error) throw error;
          const out = {};
          for (const row of data || []) out[row.code] = {
            name: row.name,
            createdAt: new Date(row.created_at).getTime(),
            lastUpdated: new Date(row.last_updated).getTime(),
            ...(row.is_deleted ? { isDeleted: true } : {})
          };
          return out;
        }
        let value = await readMeta(p[1]);
        for (const key of p.slice(2)) value = value == null ? null : value[key];
        return value;
      }
      if (p[0] === 'rooms') {
        let value = await readRoom(p[1]);
        if (p.length === 2) return value;
        if (p.length === 3 && SECTION_NAMES.has(p[2])) return value ? (value[p[2]] ?? null) : null;
        const section = p[2];
        value = value && value[section] !== undefined ? value[section] : null;
        for (const key of p.slice(3)) value = value == null ? null : value[key];
        return value;
      }
      return null;
    }

    async function ensureRoom(code) {
      const { error } = await client.from('rooms').upsert({ code }, { onConflict: 'code', ignoreDuplicates: true });
      if (error) throw error;
    }

    async function writeRoom(code, value) {
      await ensureRoom(code);
      const sections = Object.entries(value || {}).filter(([key]) => SECTION_NAMES.has(key));
      for (const [section, data] of sections) {
        const { error } = await client.from('room_data').upsert(
          { room_code: code, section, data: data || {}, updated_at: new Date().toISOString() },
          { onConflict: 'room_code,section' }
        );
        if (error) throw error;
      }
      await client.from('rooms').update({ last_updated: new Date().toISOString() }).eq('code', code);
    }

    async function writeMeta(code, field, value, remove = false) {
      const patch = {};
      if (field === 'name') patch.name = value;
      if (field === 'createdAt') patch.created_at = new Date(value).toISOString();
      if (field === 'lastUpdated') patch.last_updated = new Date(value || Date.now()).toISOString();
      if (field === 'isDeleted') patch.is_deleted = remove ? false : !!value;
      await ensureRoom(code);
      const { error } = await client.from('rooms').update(patch).eq('code', code);
      if (error) throw error;
    }

    async function patchData(code, section, path, value, remove = false) {
      await ensureRoom(code);
      const { error } = await client.rpc('patch_room_data', {
        p_room_code: code,
        p_section: section,
        p_path: path,
        p_value: value === undefined ? null : value,
        p_remove: remove
      });
      if (error) throw error;
    }

    async function writePath(path, value, remove = false) {
      const p = path.split('/').filter(Boolean);
      if (p[0] === 'rooms_meta' && p[1]) {
        if (p.length === 2 && remove) {
          const { error } = await client.from('rooms').delete().eq('code', p[1]);
          if (error) throw error;
          return;
        }
        if (p.length === 2 && !remove) {
          const meta = value || {};
          await ensureRoom(p[1]);
          const patch = {};
          if (meta.name !== undefined) patch.name = meta.name;
          if (meta.createdAt !== undefined) patch.created_at = new Date(meta.createdAt).toISOString();
          if (meta.lastUpdated !== undefined) patch.last_updated = new Date(meta.lastUpdated).toISOString();
          if (meta.isDeleted !== undefined) patch.is_deleted = !!meta.isDeleted;
          const { error } = await client.from('rooms').update(patch).eq('code', p[1]);
          if (error) throw error;
          return;
        }
        if (META_FIELDS.has(p[2])) return writeMeta(p[1], p[2], value, remove);
      }
      if (p[0] === 'rooms' && p[1]) {
        if (p.length === 2) {
          if (remove) {
            const { error } = await client.from('rooms').delete().eq('code', p[1]);
            if (error) throw error;
          } else await writeRoom(p[1], value);
          return;
        }
        const section = p[2];
        if (!SECTION_NAMES.has(section)) throw new Error('Unknown room section: ' + section);
        return patchData(p[1], section, p.slice(3), value, remove);
      }
      throw new Error('Unsupported database path: ' + path);
    }

    function ref(path = '') {
      return {
        set: value => writePath(path, value, false),
        remove: () => writePath(path, null, true),
        once: async event => {
          if (event !== 'value') throw new Error('Only value snapshots are supported');
          const value = await readPath(path);
          return snapshot(value);
        },
        on: (event, callback) => {
          if (event !== 'value') throw new Error('Only value subscriptions are supported');
          const key = path;
          const parts = key.split('/').filter(Boolean);
          const roomCode = parts[0] === 'rooms' ? parts[1] : null;
          const channel = client.channel('legacy-' + key + '-' + Math.random().toString(36).slice(2));
          if (roomCode) {
            // A room metadata update (such as last_updated) must not refresh
            // every subscribed room section. Only room deletion affects all paths.
            // DELETE postgres_changes events cannot be filtered server-side;
            // inspect the old row so only deletion of this room is forwarded.
            channel.on('postgres_changes', {
              event: '*', schema: 'public', table: 'rooms'
            }, async payload => {
              if (payload.eventType !== 'DELETE' || payload.old?.code !== roomCode) return;
              try { callback(snapshot(await readPath(key))); } catch (e) { console.error(e); }
            });

            const roomDataFilter = {
              event: '*', schema: 'public', table: 'room_data',
              filter: 'room_code=eq.' + roomCode
            };
            const section = parts[2];
            if (parts.length >= 3 && SECTION_NAMES.has(section)) {
              channel.on('postgres_changes', roomDataFilter, async payload => {
                const changedSection = payload.new?.section ?? payload.old?.section;
                if (changedSection !== section) return;
                try { callback(snapshot(await readPath(key))); } catch (e) { console.error(e); }
              });
            } else {
              channel.on('postgres_changes', roomDataFilter, async () => {
                try { callback(snapshot(await readPath(key))); } catch (e) { console.error(e); }
              });
            }
          }
          channel.subscribe(async status => {
              if (status === 'SUBSCRIBED') {
                try { callback(snapshot(await readPath(key))); } catch (e) { console.error(e); }
              }
            });
          if (!listeners.has(key)) listeners.set(key, []);
          listeners.get(key).push(channel);
          return callback;
        },
        off: () => {
          const channels = listeners.get(path) || [];
          channels.forEach(channel => client.removeChannel(channel));
          listeners.delete(path);
        },
        update: async updates => {
          for (const [subPath, value] of Object.entries(updates || {})) {
            const fullPath = [path, subPath].filter(Boolean).join('/');
            await writePath(fullPath, value, value === null);
          }
        },
        onDisconnect: () => ({
          remove: () => {
            if (disconnectHandlers.has(path)) return Promise.resolve();
            const handler = () => {
              writePath(path, null, true).catch(error => console.warn('Presence cleanup failed:', error));
              disconnectHandlers.delete(path);
            };
            disconnectHandlers.set(path, handler);
            window.addEventListener('pagehide', handler, { once: true });
            return Promise.resolve();
          }
        })
      };
    }

    return { ref };
  }

  window.createSupabaseRoomAdapter = createSupabaseRoomAdapter;
})();
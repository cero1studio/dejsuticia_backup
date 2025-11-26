import sqlite3
import json

db='C:/Users/DejusBackup/AppData/Roaming/podio-backup/podio-backup.db'
conn=sqlite3.connect(db)
cur=conn.cursor()
cur.execute('SELECT id, created_at_ms, podio_backup_item_id, summary FROM scans ORDER BY created_at_ms DESC LIMIT 1')
row=cur.fetchone()
print('lastScan:', row)
if row:
    scan_id=row[0]
    cur.execute('SELECT COUNT(*) FROM scan_apps WHERE scan_id=?',(scan_id,))
    print('apps:',cur.fetchone()[0])
    cur.execute('SELECT COUNT(*) FROM scan_files WHERE scan_id=?',(scan_id,))
    print('files:',cur.fetchone()[0])
    cur.execute("SELECT COUNT(*), SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) FROM downloads WHERE scan_id=?",(scan_id,))
    print('downloads:',cur.fetchone())
    if row[3]:
        try:
            summary=json.loads(row[3])
            print('summary keys:', list(summary.keys()))
            print('summary:', summary)
        except Exception as e:
            print('summary parse error', e)
conn.close()
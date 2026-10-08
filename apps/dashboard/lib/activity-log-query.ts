import { getPool } from '@/lib/db';
import { ACTIVITY_LOG_SELECT, mapActivityLogRow, type ActivityLog } from './activity-log';

export async function getActivityLogById(id: string, teamId: string): Promise<ActivityLog | null> {
  const { rows } = await getPool().query(
    `SELECT ${ACTIVITY_LOG_SELECT}
       FROM request_logs
      WHERE id = $1 AND team_id = $2
      LIMIT 1`,
    [id, teamId],
  );
  return rows[0] ? mapActivityLogRow(rows[0]) : null;
}

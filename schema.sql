-- Run this in your Supabase SQL editor (https://supabase.com → your project → SQL Editor)

CREATE TABLE IF NOT EXISTS tasks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',

  -- Time frame within a day (stored as "HH:MM")
  start_time TEXT,
  end_time TEXT,

  -- Date range
  start_date DATE,
  due_date DATE,

  -- Estimated time to complete (in minutes)
  duration_minutes INTEGER DEFAULT 0,

  -- Status: pending | in_progress | completed | cancelled
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled')),

  -- Recurring task settings
  is_recurring BOOLEAN DEFAULT FALSE,
  recurrence JSONB,
  -- recurrence examples:
  --   daily:   { "frequency": "daily" }
  --   weekly:  { "frequency": "weekly", "days": [1, 3, 5] }  (0=Sun)
  --   monthly: { "frequency": "monthly", "day": 15 }
  --   yearly:  { "frequency": "yearly", "month": 6, "day": 15 }
  last_completed_at TIMESTAMPTZ,

  -- Prerequisite task IDs (tasks that must be completed first)
  prerequisite_ids UUID[] DEFAULT '{}',

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Allow public read/write (no auth required)
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all" ON tasks FOR ALL USING (true) WITH CHECK (true);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

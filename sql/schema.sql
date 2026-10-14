CREATE TABLE IF NOT EXISTS batch_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_seconds numeric,
  input_dir text NOT NULL,
  output_dir text NOT NULL,
  config_path text NOT NULL,
  config jsonb NOT NULL,
  simplify_override text,
  single_file text,
  file_count integer NOT NULL DEFAULT 0,
  ok_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  status text NOT NULL,
  exit_code integer,
  error_message text,
  CONSTRAINT batch_runs_status_check CHECK (status IN ('running', 'completed', 'aborted'))
);

CREATE TABLE IF NOT EXISTS batch_assets (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id bigint NOT NULL REFERENCES batch_runs (id) ON DELETE CASCADE,
  position integer NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now(),
  input_name text NOT NULL,
  output_name text,
  status text NOT NULL,
  duration_seconds numeric,
  output_bytes bigint,
  scans integer,
  smooth boolean,
  transparent boolean,
  speckles integer,
  speckles_auto boolean,
  median_size integer,
  median_auto boolean,
  flat_colors integer,
  error_message text,
  CONSTRAINT batch_assets_status_check CHECK (status IN ('ok', 'skipped', 'error')),
  CONSTRAINT batch_assets_batch_position_unique UNIQUE (batch_id, position)
);

CREATE INDEX IF NOT EXISTS batch_assets_batch_id_idx ON batch_assets (batch_id);

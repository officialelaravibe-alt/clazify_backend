-- Clazify backend schema (PostgreSQL). Safe to run many times.
-- The server runs this file on start-up, then src/migrate.js upgrades older databases.

CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(100) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    name_key VARCHAR(100),                 -- normalised name used to match LAS names
    designation VARCHAR(100),
    email VARCHAR(100) UNIQUE,             -- optional
    team_id VARCHAR(50),
    role VARCHAR(20) DEFAULT 'MEMBER',     -- 'MEMBER', 'LEADER'
    fcm_token TEXT,                        -- never returned by the API
    token_hash CHAR(64),                   -- SHA-256 of the device token (token itself is never stored)
    token_created_at TIMESTAMPTZ,
    last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS teams (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    subject VARCHAR(100),
    leader_id VARCHAR(100) REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tasks (
    id VARCHAR(100) PRIMARY KEY,
    content TEXT NOT NULL,
    assigned_by VARCHAR(100) REFERENCES users(id) ON DELETE CASCADE,
    assigned_by_name VARCHAR(100),
    assigned_to VARCHAR(100) REFERENCES users(id) ON DELETE CASCADE,
    assigned_to_name VARCHAR(100),
    due_date VARCHAR(50),
    is_completed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS events (
    id VARCHAR(100) PRIMARY KEY,
    title VARCHAR(150) NOT NULL,
    description TEXT,
    event_type VARCHAR(20) NOT NULL,       -- 'ST', 'EXAM', 'LEAVE'
    start_timestamp BIGINT NOT NULL,
    end_timestamp BIGINT NOT NULL,
    trainer_id VARCHAR(100) REFERENCES users(id) ON DELETE CASCADE,
    trainer_name VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS syllabus_progress (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(100) REFERENCES users(id) ON DELETE CASCADE,
    subject_name VARCHAR(100) NOT NULL,
    lecture_interval VARCHAR(50) NOT NULL,
    sub_topic_label VARCHAR(255) NOT NULL,
    status VARCHAR(20) DEFAULT 'Pending',  -- 'Pending', 'In Progress', 'Completed'
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, subject_name, lecture_interval)
);

CREATE TABLE IF NOT EXISTS attendance_records (
    id SERIAL PRIMARY KEY,
    subject_code VARCHAR(50) NOT NULL,
    batch_section VARCHAR(50) NOT NULL,
    date VARCHAR(20) NOT NULL,
    lecture_time_slot VARCHAR(50),
    lecture1_attendance INT DEFAULT 0,
    lecture2_attendance INT DEFAULT 0,
    total_students INT DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(subject_code, batch_section, date)
);

-- Lecture adjustments sent by the LAS desktop app. One row per proxy lecture.
CREATE TABLE IF NOT EXISTS adjustments (
    id VARCHAR(100) PRIMARY KEY,
    date VARCHAR(50) NOT NULL,             -- YYYY-MM-DD
    day_of_week VARCHAR(10),
    absent_trainer VARCHAR(100) NOT NULL,
    assigned_to VARCHAR(100) NOT NULL,     -- name as written in LAS
    assigned_key VARCHAR(100),             -- normalised name
    assigned_email VARCHAR(150),           -- work email from the LAS team list (preferred for matching)
    user_id VARCHAR(100),                  -- matched Clazify user (NULL = not matched yet)
    class_name VARCHAR(100) NOT NULL,
    course_code VARCHAR(100),
    venue VARCHAR(100),
    slot_label VARCHAR(50),
    time_schedule VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Team list managed by the manager in LAS (only these emails can sign in).
CREATE TABLE IF NOT EXISTS team_members (
    email VARCHAR(150) PRIMARY KEY,        -- lower-case, @codequotient.com or @cqst.in
    name VARCHAR(100) NOT NULL,            -- name as written in LAS
    name_key VARCHAR(100),
    role VARCHAR(20) NOT NULL DEFAULT 'TRAINER',   -- 'TRAINER' or 'MANAGER'
    active BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Signed-in devices. Only the SHA-256 of each token is stored.
CREATE TABLE IF NOT EXISTS sessions (
    token_hash CHAR(64) PRIMARY KEY,
    email VARCHAR(150) NOT NULL,
    kind VARCHAR(10) NOT NULL,             -- 'app' (Clazify phone) or 'las' (manager desktop)
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_used_at TIMESTAMPTZ DEFAULT NOW()
);

-- Timetable read by the server from the newest PDF in the Drive folder.
-- Only the pages of LAS team members are parsed; LAS and the app read it from here.
CREATE TABLE IF NOT EXISTS timetables (
    id SERIAL PRIMARY KEY,
    drive_file_id VARCHAR(100) NOT NULL,
    file_name VARCHAR(255),
    drive_modified VARCHAR(40),            -- Drive modifiedTime; a new value means a new upload
    effective_from VARCHAR(20),            -- from the file name (dd.mm.yyyy), may be empty
    generated_on VARCHAR(20),              -- "Timetable generated: dd-mm-yyyy" in the PDF
    page_count INT,
    team_hash CHAR(64),                    -- team list used for this parse (re-parse when it changes)
    teacher_names JSONB,                   -- every teacher name in the PDF headers
    unmatched JSONB,                       -- team members whose name was not found in the PDF
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    parsed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS timetable_entries (
    id SERIAL PRIMARY KEY,
    timetable_id INT NOT NULL REFERENCES timetables(id) ON DELETE CASCADE,
    email VARCHAR(150) NOT NULL,           -- team member (matched by the name on the PDF page)
    teacher_name VARCHAR(100) NOT NULL,    -- name as written in the PDF
    day_of_week VARCHAR(4) NOT NULL,       -- Mo, Tu, We, Th, Fr, Sa
    slots INT[] NOT NULL,                  -- e.g. {1,2} for a two-slot lecture
    course_code VARCHAR(100),
    venue VARCHAR(100),
    class_name VARCHAR(100)
);
CREATE INDEX IF NOT EXISTS timetable_entries_tt_email_idx ON timetable_entries(timetable_id, email);

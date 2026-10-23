-- Native libraries and programs found inside each file: path, sha256, size and platform. Used to flag
-- natives that are new or changed since the last live version, and to show players a native-code badge.
ALTER TABLE files ADD COLUMN natives TEXT;

CREATE TABLE order_preferences (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  prefer_priority BOOLEAN NOT NULL DEFAULT FALSE
);

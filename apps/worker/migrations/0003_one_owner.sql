-- At most one owner per workspace, even under concurrent first sign-ins.
CREATE UNIQUE INDEX workspace_one_owner ON workspace_members(workspace_id) WHERE role = 'owner';

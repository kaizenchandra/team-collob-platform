-- Employment reporting is independent of chat-team membership and workspace roles.
-- No rows are invented or backfilled from team ownership.
CREATE TABLE organization_people (
 org_id uuid NOT NULL,user_id uuid NOT NULL,manager_id uuid,
 reporting_status text NOT NULL DEFAULT 'unknown' CHECK(reporting_status IN('unknown','root','assigned')),
 department text NOT NULL DEFAULT '' CHECK(length(department)<=160),
 organizational_unit text NOT NULL DEFAULT '' CHECK(length(organizational_unit)<=160),
 work_location text NOT NULL DEFAULT '' CHECK(length(work_location)<=200),
 visibility text NOT NULL DEFAULT 'workspace' CHECK(visibility IN('workspace','restricted')),
 source_label text NOT NULL DEFAULT 'Workspace directory' CHECK(length(source_label) BETWEEN 1 AND 120),
 source_as_of timestamptz,updated_at timestamptz NOT NULL DEFAULT now(),revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 PRIMARY KEY(org_id,user_id),
 FOREIGN KEY(org_id,user_id) REFERENCES memberships(org_id,user_id),
 FOREIGN KEY(org_id,manager_id) REFERENCES memberships(org_id,user_id),
 CHECK((reporting_status='assigned')=(manager_id IS NOT NULL)),CHECK(manager_id IS DISTINCT FROM user_id)
);
CREATE INDEX organization_direct_reports ON organization_people(org_id,manager_id,user_id) WHERE reporting_status='assigned';
CREATE INDEX organization_departments ON organization_people(org_id,department,user_id);
CREATE FUNCTION organization_person_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at=now();NEW.revision=OLD.revision+1;RETURN NEW;END $$;
CREATE TRIGGER organization_person_changed BEFORE UPDATE ON organization_people FOR EACH ROW EXECUTE FUNCTION organization_person_changed();

import { Code, H2, LI, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function Tags() {
  return (
    <>
      <PageHeader
        eyebrow="Core concepts"
        title="Tags"
        lead={
          <>
            Tags are reusable, color-coded company labels for organizing resources. Create any names
            your team needs, then attach several tags to the same resource.
          </>
        }
      />

      <H2 id="add-tags">Add tags to a resource</H2>
      <UL>
        <LI>
          Open a Routine, Skill, Resource, Project, Base, Notebook, Note, Pipeline, Code Repository,
          Chart, or Dashboard.
        </LI>
        <LI>
          Under <Strong>Tags</Strong>, choose an existing company tag or type a new name and press
          Enter.
        </LI>
        <LI>
          Repeat to attach multiple tags. Remove a tag with the × beside its name; the tag remains
          available to the rest of the company.
        </LI>
      </UL>
      <P>
        The same picker is available while creating a Routine, Skill, or Resource. Those three
        company-wide list pages also show tag chips and let you filter down to one tag at a time.
      </P>

      <H2 id="manage">Manage the company catalog</H2>
      <P>
        Go to <Strong>Settings → Tags</Strong> to create, rename, or delete company tags. Renaming
        or changing a color updates every attached resource. New tags created here use the color you
        choose; tags created inline receive a color automatically and can be adjusted later.
        Deleting a tag removes only the label and its assignments — it never deletes the resources
        themselves. The usage count shows how widely each tag is used before you make a change.
      </P>

      <H2 id="names">Naming</H2>
      <P>
        Names are free-form, up to 50 characters, and case-insensitive inside one company. For
        example, <Code>Marketing</Code> and <Code>marketing</Code> resolve to the same tag. Short
        names such as <Code>finance</Code>, <Code>weekly</Code>, or <Code>customer-facing</Code> are
        easiest to scan in lists.
      </P>
    </>
  );
}

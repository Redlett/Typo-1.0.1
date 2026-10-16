/**
 * Built-in Document Presets / Templates for Typo's Microsoft Word-style Start Screen.
 * Each preset configures page settings (margins, orientation, header, footer, page numbers),
 * default typography (font family & size), and rich initial ProseMirror document content.
 */
import type { PageSettings, DocDefaults } from "./native";

export type PresetCategory = "all" | "academic" | "business" | "productivity" | "creative";

export interface DocumentPreset {
  id: string;
  name: string;
  subtitle: string;
  category: Exclude<PresetCategory, "all">;
  badge?: string;
  previewStyle: "blank" | "brainstorm" | "academic" | "resume" | "table" | "letter" | "report" | "script" | "notes";
  defaults?: Partial<DocDefaults>;
  page?: Partial<PageSettings>;
  html: string;
}

export const PRESET_CATEGORIES: { id: PresetCategory; label: string }[] = [
  { id: "all", label: "All Presets" },
  { id: "academic", label: "Academic & School" },
  { id: "business", label: "Work & Business" },
  { id: "productivity", label: "Notes & Planning" },
  { id: "creative", label: "Creative & Media" },
];

export const DOCUMENT_PRESETS: DocumentPreset[] = [
  // 1. Blank Document
  {
    id: "blank",
    name: "Blank document",
    subtitle: "Clean empty page",
    category: "productivity",
    previewStyle: "blank",
    html: "<p></p>",
  },

  // 2. Brainstorm Canvas (Landscape + Pencil Draw Tool)
  {
    id: "brainstorm",
    name: "Brainstorm",
    subtitle: "Landscape · Pencil & Doodle Canvas",
    category: "creative",
    badge: "Draw & Sketch",
    previewStyle: "brainstorm",
    defaults: { fontFamily: "Calibri", fontSize: 12 },
    page: {
      size: "A4",
      orientation: "landscape",
      margins: { top: 0.6, right: 0.6, bottom: 0.6, left: 0.6 },
    },
    html: `<p></p>`,
  },

  // 2. APA 7th Edition Paper
  {
    id: "apa-paper",
    name: "APA 7th Edition Paper",
    subtitle: "Double-spaced · Times 12pt",
    category: "academic",
    badge: "APA 7",
    previewStyle: "academic",
    defaults: { fontFamily: "Times New Roman", fontSize: 12 },
    page: {
      size: "Letter",
      orientation: "portrait",
      margins: { top: 1, right: 1, bottom: 1, left: 1 },
      header: "RUNNING HEAD: SHORTENED TITLE OF PAPER",
      pageNumbers: true,
    },
    html: `
      <p style="line-height: 2" data-align="center"><strong>Full Title of Your Research Paper in Bold Title Case</strong></p>
      <p style="line-height: 2" data-align="center">Your Name</p>
      <p style="line-height: 2" data-align="center">Department Name, University or Institution</p>
      <p style="line-height: 2" data-align="center">Course Code: Course Name</p>
      <p style="line-height: 2" data-align="center">Instructor Name</p>
      <p style="line-height: 2" data-align="center">October 16, 2026</p>
      <div data-page-break="true" class="page-break"></div>
      <h2 style="line-height: 2" data-align="center">Abstract</h2>
      <p style="line-height: 2">Write a concise summary of your research paper here (typically 150 to 250 words). In APA style, the abstract paragraph is not indented. Summarize your research topic, questions, participants, methods, results, and conclusions.</p>
      <p style="line-height: 2"><em>Keywords:</em> keyword one, keyword two, keyword three, keyword four</p>
      <div data-page-break="true" class="page-break"></div>
      <h1 style="line-height: 2" data-align="center">Full Title of Your Research Paper</h1>
      <p style="line-height: 2">Begin your introduction here. State the problem under investigation, provide background context from scholarly literature, and clearly state your thesis or hypothesis.</p>
      <h2 style="line-height: 2">Method</h2>
      <p style="line-height: 2">Describe the research design, participants, materials, and procedure used in your study.</p>
      <h2 style="line-height: 2">Results &amp; Discussion</h2>
      <p style="line-height: 2">Present your key findings and interpret their significance in relation to your original hypothesis.</p>
      <div data-page-break="true" class="page-break"></div>
      <h2 style="line-height: 2" data-align="center">References</h2>
      <p style="line-height: 2">Author, A. A., &amp; Author, B. B. (Year). Title of the article in sentence case. <em>Title of the Periodical</em>, <em>Volume</em>(Issue), pp–pp. https://doi.org/xxxx</p>
    `,
  },

  // 3. MLA 9th Edition Essay
  {
    id: "mla-essay",
    name: "MLA 9th Edition Essay",
    subtitle: "Header block · Works Cited",
    category: "academic",
    badge: "MLA 9",
    previewStyle: "academic",
    defaults: { fontFamily: "Times New Roman", fontSize: 12 },
    page: {
      size: "Letter",
      orientation: "portrait",
      margins: { top: 1, right: 1, bottom: 1, left: 1 },
      header: "Last Name",
      pageNumbers: true,
    },
    html: `
      <p style="line-height: 2">Your Full Name</p>
      <p style="line-height: 2">Professor's Name</p>
      <p style="line-height: 2">Course Name and Number</p>
      <p style="line-height: 2">16 October 2026</p>
      <p style="line-height: 2" data-align="center">Title of Your Essay in Title Case (Not Bold or Underlined)</p>
      <p style="line-height: 2">Start your introductory paragraph here. In MLA 9th edition, the entire essay is double-spaced with 1-inch margins on all sides. Introduce your topic, provide necessary context, and end the opening paragraph with a clear thesis statement.</p>
      <p style="line-height: 2">Begin your first body paragraph with a clear topic sentence that supports your thesis. Incorporate textual evidence and parenthetical citations in (Author Page) format.</p>
      <div data-page-break="true" class="page-break"></div>
      <p style="line-height: 2" data-align="center">Works Cited</p>
      <p style="line-height: 2">Last Name, First Name. <em>Title of Book</em>. Publisher, Publication Year.</p>
      <p style="line-height: 2">Last Name, First Name. "Title of Article." <em>Title of Journal</em>, vol. 12, no. 3, Year, pp. 45–62.</p>
    `,
  },

  // 4. Modern Resume / CV
  {
    id: "modern-resume",
    name: "Modern Resume / CV",
    subtitle: "Clean ATS-friendly layout",
    category: "business",
    badge: "Popular",
    previewStyle: "resume",
    defaults: { fontFamily: "Calibri", fontSize: 11 },
    page: {
      size: "Letter",
      orientation: "portrait",
      margins: { top: 0.75, right: 0.75, bottom: 0.75, left: 0.75 },
    },
    html: `
      <p data-style="Title"><strong>ALEXANDER VANCE</strong></p>
      <p data-style="Subtitle">Senior Product Designer &amp; Systems Architect · City, Country · alex@example.com · (555) 234-5678 · portfolio.example.com</p>
      <hr>
      <h2>PROFESSIONAL SUMMARY</h2>
      <p>Results-driven professional with 6+ years of experience designing, building, and scaling high-impact software products and workflows. Proven track record of leading cross-functional teams and delivering measurable improvements in performance and user satisfaction.</p>
      <h2>WORK EXPERIENCE</h2>
      <p><strong>Lead Product Engineer — Horizon Labs</strong> <em>(2023 – Present)</em></p>
      <ul>
        <li><p>Spearheaded the core architecture overhaul, reducing load times by 48% across 120,000+ daily active users.</p></li>
        <li><p>Partnered with design, engineering, and product stakeholders to launch 4 flagship features ahead of schedule.</p></li>
        <li><p>Mentored a team of 6 mid-level engineers and established automated quality assurance pipelines.</p></li>
      </ul>
      <p><strong>Full-Stack Developer — Northstar Digital</strong> <em>(2020 – 2023)</em></p>
      <ul>
        <li><p>Developed responsive web and desktop applications with modern TypeScript, Rust, and SQL backends.</p></li>
        <li><p>Streamlined client onboarding workflows, increasing conversion rates by 27% in Q3.</p></li>
      </ul>
      <h2>EDUCATION</h2>
      <p><strong>B.S. in Computer Science</strong> — State University of Technology <em>(Graduated 2020, Magna Cum Laude)</em></p>
      <h2>CORE SKILLS</h2>
      <p><strong>Technical:</strong> TypeScript, Rust, Python, SQL, System Design, UI/UX Architecture, Performance Optimization</p>
      <p><strong>Languages &amp; Tools:</strong> Git, Linux, Docker, Figma, Adobe Creative Suite, Agile / Scrum</p>
    `,
  },

  // 5. Meeting Notes & Action Items
  {
    id: "meeting-notes",
    name: "Meeting Notes & Tasks",
    subtitle: "Agenda + Action checklist",
    category: "productivity",
    badge: "Checklist",
    previewStyle: "notes",
    html: `
      <p data-style="Title">Weekly Sync &amp; Action Plan</p>
      <p data-style="Subtitle">Date: October 16, 2026 · Time: 10:00 AM · Location: Room 4B / Video Call</p>
      <table>
        <tr>
          <th><p>Facilitator</p></th>
          <td><p>Your Name</p></td>
          <th><p>Attendees</p></th>
          <td><p>Sarah, Marcus, Elena, Devon</p></td>
        </tr>
        <tr>
          <th><p>Sprint / Goal</p></th>
          <td colspan="3"><p>Finalize Q4 release milestones and resolve open blockers</p></td>
        </tr>
      </table>
      <h2>1. Agenda &amp; Discussion Points</h2>
      <ul>
        <li><p><strong>Project Status Review:</strong> Current progress on core deliverables and timeline check.</p></li>
        <li><p><strong>Open Blockers:</strong> Identify resource bottlenecks and cross-team dependencies.</p></li>
        <li><p><strong>Upcoming Deadlines:</strong> Confirm handoff dates for QA and final review.</p></li>
      </ul>
      <h2>2. Key Decisions Made</h2>
      <blockquote>
        <p>Approved moving the beta launch forward by one week and prioritizing stability polish over secondary stretch goals.</p>
      </blockquote>
      <h2>3. Action Items &amp; Owners</h2>
      <ul data-type="taskList">
        <li data-type="taskItem" data-checked="true"><p> circulate updated roadmap deck to all stakeholders — <strong>@Sarah</strong></p></li>
        <li data-type="taskItem" data-checked="false"><p>Complete final security &amp; performance audit — <strong>@Marcus (Due Friday)</strong></p></li>
        <li data-type="taskItem" data-checked="false"><p>Prepare release notes and customer announcement draft — <strong>@Elena (Due Monday)</strong></p></li>
      </ul>
    `,
  },

  // 6. Business / Cover Letter
  {
    id: "business-letter",
    name: "Business / Cover Letter",
    subtitle: "Formal correspondence",
    category: "business",
    previewStyle: "letter",
    defaults: { fontFamily: "Calibri", fontSize: 11 },
    html: `
      <p><strong>Your Full Name</strong><br>123 Innovation Way, Suite 400<br>City, State 10001<br>you@example.com · (555) 123-4567</p>
      <p>October 16, 2026</p>
      <p><strong>Hiring Manager / Recipient Name</strong><br>Title / Department<br>Company Name<br>456 Enterprise Blvd, Floor 12<br>City, State 10002</p>
      <p><strong>Re: Application for Senior Specialist Position</strong></p>
      <p>Dear Hiring Manager,</p>
      <p>I am writing to express my strong interest in the Senior Specialist role at Company Name. With a proven background in delivering high-impact projects and optimizing team workflows, I am confident in my ability to contribute immediately to your department's goals.</p>
      <p>In my current role, I led initiatives that improved operational efficiency by 35% while maintaining rigorous quality standards. I particularly admire Company Name's commitment to craftsmanship and user-centric engineering, and I would welcome the opportunity to bring my expertise to your team.</p>
      <p>Thank you for your time and consideration. I look forward to the possibility of discussing how my background aligns with your current needs.</p>
      <p>Sincerely,</p>
      <p><br><strong>Your Full Name</strong></p>
    `,
  },

  // 7. Project Proposal / Executive Report
  {
    id: "project-proposal",
    name: "Project Proposal",
    subtitle: "Scope, timeline & budget",
    category: "business",
    previewStyle: "report",
    page: {
      size: "A4",
      orientation: "portrait",
      margins: { top: 1, right: 1, bottom: 1, left: 1 },
      header: "PROJECT PROPOSAL — CONFIDENTIAL",
      footer: "Prepared with Typo",
      pageNumbers: true,
    },
    html: `
      <p data-style="Title">Next-Gen Platform Initiative</p>
      <p data-style="Subtitle">Project Proposal &amp; Execution Roadmap · Prepared by Your Name · Q4 2026</p>
      <hr>
      <h1>1. Executive Summary</h1>
      <p>This proposal outlines the strategic vision, scope, deliverables, and resource plan for the Next-Gen Platform Initiative. The objective is to modernize core workflows, reduce maintenance overhead, and deliver a seamless user experience.</p>
      <h1>2. Objectives &amp; Success Metrics</h1>
      <ol>
        <li><p><strong>Performance:</strong> Achieve sub-100ms response times across all primary workflows.</p></li>
        <li><p><strong>Reliability:</strong> Maintain 99.95% uptime with automated fault recovery.</p></li>
        <li><p><strong>Adoption:</strong> Onboard 100% of internal teams within 60 days of launch.</p></li>
      </ol>
      <h1>3. Milestones &amp; Estimated Budget</h1>
      <table>
        <tr>
          <th><p>Phase</p></th>
          <th><p>Deliverables</p></th>
          <th><p>Target Date</p></th>
          <th><p>Budget</p></th>
        </tr>
        <tr>
          <td><p><strong>Phase 1: Discovery</strong></p></td>
          <td><p>Requirements audit &amp; technical specification</p></td>
          <td><p>Week 2</p></td>
          <td><p>$4,500</p></td>
        </tr>
        <tr>
          <td><p><strong>Phase 2: Core Build</strong></p></td>
          <td><p>Working prototype, API integration &amp; internal alpha</p></td>
          <td><p>Week 6</p></td>
          <td><p>$12,000</p></td>
        </tr>
        <tr>
          <td><p><strong>Phase 3: Launch</strong></p></td>
          <td><p>QA sign-off, documentation &amp; production rollout</p></td>
          <td><p>Week 8</p></td>
          <td><p>$3,500</p></td>
        </tr>
      </table>
    `,
  },

  // 8. Cornell Study Notes
  {
    id: "cornell-notes",
    name: "Cornell Study Notes",
    subtitle: "Cue column + Lecture notes",
    category: "academic",
    badge: "Study",
    previewStyle: "table",
    html: `
      <p data-style="Title">Cornell Lecture &amp; Study Notes</p>
      <p data-style="Subtitle">Course / Topic: ______________________ · Date: October 16, 2026 · Chapter / Lecture #: ____</p>
      <table>
        <tr>
          <th><p>Cues, Keywords &amp; Questions (30%)</p></th>
          <th><p>Main Lecture &amp; Reading Notes (70%)</p></th>
        </tr>
        <tr>
          <td>
            <p><strong>What is the core principle?</strong></p>
            <p><em>Key term / definition</em></p>
          </td>
          <td>
            <p>Record main ideas, formulas, diagrams, and examples here during the lecture or reading session.</p>
            <ul>
              <li><p>Supporting detail or evidence #1</p></li>
              <li><p>Supporting detail or evidence #2</p></li>
            </ul>
          </td>
        </tr>
        <tr>
          <td>
            <p><strong>How does Mechanism X compare to Y?</strong></p>
          </td>
          <td>
            <p>Explain cause-and-effect relationships, contrasts, and practical applications.</p>
          </td>
        </tr>
        <tr>
          <td>
            <p><strong>Exam / Review Question</strong></p>
          </td>
          <td>
            <p>Write potential exam prompts or tricky edge cases to review later.</p>
          </td>
        </tr>
      </table>
      <h2>Summary (Synthesize in 2–3 sentences at the end of study session)</h2>
      <blockquote>
        <p>Summarize the most important takeaway from this page in your own words so you can review it in 30 seconds before an exam.</p>
      </blockquote>
    `,
  },

  // 9. Lab / Scientific Research Report
  {
    id: "lab-report",
    name: "Lab / Research Report",
    subtitle: "Hypothesis, Data & Analysis",
    category: "academic",
    previewStyle: "report",
    page: { pageNumbers: true },
    html: `
      <p data-style="Title">Laboratory Investigation Report</p>
      <p data-style="Subtitle">Experiment Title · Lab Partner(s): ______________ · Date: October 16, 2026</p>
      <hr>
      <h2>1. Objective &amp; Hypothesis</h2>
      <p><strong>Objective:</strong> State the scientific purpose of this experiment.</p>
      <p><strong>Hypothesis:</strong> If <em>[independent variable]</em> is changed, then <em>[dependent variable]</em> will <em>[expected outcome]</em> because <em>[scientific rationale]</em>.</p>
      <h2>2. Materials &amp; Equipment</h2>
      <ul>
        <li><p>Analytical balance (±0.001 g), volumetric flasks (100 mL), digital thermometer</p></li>
        <li><p>Reagents and standard control solutions</p></li>
      </ul>
      <h2>3. Experimental Procedure</h2>
      <ol>
        <li><p>Calibrate all measuring instruments and record baseline ambient conditions.</p></li>
        <li><p>Prepare three trial samples and one control sample under identical conditions.</p></li>
      </ol>
      <h2>4. Data &amp; Observations</h2>
      <table>
        <tr>
          <th><p>Trial #</p></th>
          <th><p>Control Value</p></th>
          <th><p>Measured Output</p></th>
          <th><p>% Error / Notes</p></th>
        </tr>
        <tr>
          <td><p>Trial 1</p></td>
          <td><p>10.00</p></td>
          <td><p>10.12</p></td>
          <td><p>+1.2%</p></td>
        </tr>
        <tr>
          <td><p>Trial 2</p></td>
          <td><p>10.00</p></td>
          <td><p>9.96</p></td>
          <td><p>-0.4%</p></td>
        </tr>
      </table>
      <h2>5. Discussion &amp; Conclusion</h2>
      <p>Analyze experimental error sources and state whether the empirical results support your initial hypothesis.</p>
    `,
  },

  // 10. Invoice / Freelance Billing Sheet
  {
    id: "invoice-sheet",
    name: "Invoice & Billing Sheet",
    subtitle: "Itemized services & totals",
    category: "business",
    badge: "Finance",
    previewStyle: "table",
    html: `
      <p data-style="Title">INVOICE #INV-2026-001</p>
      <p data-style="Subtitle">Issue Date: October 16, 2026 · Due Date: November 15, 2026 (Net 30)</p>
      <table>
        <tr>
          <th><p>FROM (Service Provider)</p></th>
          <th><p>BILL TO (Client)</p></th>
        </tr>
        <tr>
          <td><p><strong>Your Name / Studio LLC</strong><br>123 Creative Ave<br>billing@example.com</p></td>
          <td><p><strong>Client Company Name</strong><br>Attn: Accounts Payable<br>ap@client.example.com</p></td>
        </tr>
      </table>
      <h2>Itemized Services</h2>
      <table>
        <tr>
          <th><p>Description</p></th>
          <th><p>Qty / Hours</p></th>
          <th><p>Rate</p></th>
          <th><p>Line Total</p></th>
        </tr>
        <tr>
          <td><p>UI/UX Design &amp; Frontend Architecture</p></td>
          <td><p>20 hrs</p></td>
          <td><p>$95.00</p></td>
          <td><p>$1,900.00</p></td>
        </tr>
        <tr>
          <td><p>Backend Integration &amp; Performance Optimization</p></td>
          <td><p>12 hrs</p></td>
          <td><p>$95.00</p></td>
          <td><p>$1,140.00</p></td>
        </tr>
        <tr>
          <td colspan="3"><p data-align="right"><strong>TOTAL DUE (USD)</strong></p></td>
          <td><p><strong>$3,040.00</strong></p></td>
        </tr>
      </table>
      <h2>Payment Instructions &amp; Notes</h2>
      <p>Please remit payment via ACH bank transfer or wire to the account details on file. Thank you for your business!</p>
    `,
  },

  // 11. Standard Operating Procedure (SOP)
  {
    id: "sop-guide",
    name: "Technical SOP / Guide",
    subtitle: "Step-by-step runbook",
    category: "business",
    previewStyle: "report",
    page: { header: "STANDARD OPERATING PROCEDURE", pageNumbers: true },
    html: `
      <p data-style="Title">Standard Operating Procedure (SOP)</p>
      <p data-style="Subtitle">Document ID: SOP-ENG-042 · Version: 1.0 · Owner: Operations &amp; Engineering</p>
      <hr>
      <h2>1. Purpose &amp; Scope</h2>
      <p>Defines the repeatable step-by-step procedure for deploying production updates safely and verifying post-release health checks.</p>
      <h2>2. PrerequisitesChecklist</h2>
      <ul data-type="taskList">
        <li data-type="taskItem" data-checked="true"><p>All automated unit and integration tests passing on main branch</p></li>
        <li data-type="taskItem" data-checked="false"><p>Database backup snapshot verified within the last 15 minutes</p></li>
      </ul>
      <h2>3. Step-by-Step Procedure</h2>
      <ol>
        <li><p><strong>Build Release Package:</strong> Compile the release artifacts in clean mode:</p></li>
      </ol>
      <pre><code>npm run build
cargo build --release</code></pre>
      <ol start="2">
        <li><p><strong>Run Smoke Verification:</strong> Verify the binary launches cleanly and passes health checks.</p></li>
        <li><p><strong>Sign Off:</strong> Record the deployment timestamp in the revision log below.</p></li>
      </ol>
    `,
  },

  // 12. Press Release / Newsletter
  {
    id: "press-release",
    name: "Press Release / Article",
    subtitle: "Media & newsletter draft",
    category: "creative",
    previewStyle: "letter",
    html: `
      <p><strong>FOR IMMEDIATE RELEASE</strong></p>
      <p data-style="Title">Headline: Bold, Newsworthy Announcement Goes Here</p>
      <p data-style="Subtitle">Subheadline summarizing the key takeaway and why it matters to readers in one compelling sentence.</p>
      <p><strong>CITY, STATE — October 16, 2026</strong> — Start your lead paragraph with the most important facts (who, what, when, where, and why). Hook the reader immediately with concrete numbers or outcomes.</p>
      <p>In the second paragraph, expand on the context, features, or story behind the announcement. Explain how this solves a real problem for users or the community.</p>
      <blockquote>
        <p>"Include a memorable, natural-sounding quote from a founder, creator, or project lead that adds perspective and personality to the story."</p>
      </blockquote>
      <h2>Key Highlights</h2>
      <ul>
        <li><p><strong>Highlight One:</strong> Brief description of the first major benefit or milestone.</p></li>
        <li><p><strong>Highlight Two:</strong> Brief description of availability, pricing, or technical innovation.</p></li>
      </ul>
      <p data-align="center"><strong>###</strong></p>
      <p><strong>Media Contact:</strong> Name · press@example.com · https://example.com</p>
    `,
  },

  // 13. Weekly Planner & Habit Tracker
  {
    id: "weekly-planner",
    name: "Weekly Planner",
    subtitle: "Top 3 goals + 7-day grid",
    category: "productivity",
    badge: "Planner",
    previewStyle: "table",
    html: `
      <p data-style="Title">Weekly Focus &amp; Schedule</p>
      <p data-style="Subtitle">Week of: October 16, 2026 · Theme of the Week: Deep Focus &amp; Execution</p>
      <h2>Top 3 Must-Win Priorities This Week</h2>
      <ul data-type="taskList">
        <li data-type="taskItem" data-checked="false"><p>Priority #1: </p></li>
        <li data-type="taskItem" data-checked="false"><p>Priority #2: </p></li>
        <li data-type="taskItem" data-checked="false"><p>Priority #3: </p></li>
      </ul>
      <h2>7-Day Schedule</h2>
      <table>
        <tr>
          <th><p>Day</p></th>
          <th><p>Main Focus / Deep Work</p></th>
          <th><p>Meetings / Deadlines / Errands</p></th>
        </tr>
        <tr><td><p><strong>Monday</strong></p></td><td><p></p></td><td><p></p></td></tr>
        <tr><td><p><strong>Tuesday</strong></p></td><td><p></p></td><td><p></p></td></tr>
        <tr><td><p><strong>Wednesday</strong></p></td><td><p></p></td><td><p></p></td></tr>
        <tr><td><p><strong>Thursday</strong></p></td><td><p></p></td><td><p></p></td></tr>
        <tr><td><p><strong>Friday</strong></p></td><td><p></p></td><td><p></p></td></tr>
        <tr><td><p><strong>Weekend</strong></p></td><td><p></p></td><td><p></p></td></tr>
      </table>
      <h2>Brain Dump &amp; Notes</h2>
      <p>Jot down quick ideas, reminders, or follow-ups here…</p>
    `,
  },

  // 14. Daily Journal & Brain Dump
  {
    id: "daily-journal",
    name: "Daily Journal",
    subtitle: "Mindfulness & daily log",
    category: "productivity",
    previewStyle: "notes",
    defaults: { fontFamily: "Georgia", fontSize: 11.5 },
    html: `
      <p data-style="Title">Daily Journal Entry</p>
      <p data-style="Subtitle">Friday, October 16, 2026 · Mood / Energy: 8 / 10</p>
      <hr>
      <h2>Today's Intention</h2>
      <blockquote>
        <p>What is the single most meaningful thing I can make progress on today?</p>
      </blockquote>
      <h2>Quick Check-In</h2>
      <ul data-type="taskList">
        <li data-type="taskItem" data-checked="false"><p>Hydration &amp; movement break</p></li>
        <li data-type="taskItem" data-checked="false"><p>Zero-distraction deep work block</p></li>
        <li data-type="taskItem" data-checked="false"><p>Evening wind-down</p></li>
      </ul>
      <h2>Thoughts, Wins &amp; Freewriting</h2>
      <p>Start writing freely here…</p>
    `,
  },

  // 15. Novel / Creative Manuscript
  {
    id: "novel-manuscript",
    name: "Novel / Story Manuscript",
    subtitle: "Georgia 12pt · Chapter layout",
    category: "creative",
    badge: "Fiction",
    previewStyle: "academic",
    defaults: { fontFamily: "Georgia", fontSize: 12 },
    page: {
      size: "A4",
      orientation: "portrait",
      margins: { top: 1, right: 1, bottom: 1, left: 1 },
      header: "MANUSCRIPT DRAFT",
      pageNumbers: true,
    },
    html: `
      <p data-align="center"><br></p>
      <h1 data-align="center">CHAPTER ONE</h1>
      <p data-style="Subtitle" data-align="center">The Signal in the Static</p>
      <p style="line-height: 1.5">The rain had been drumming against the neon-lit glass for three hours before the terminal finally blinked awake. Across the desk, a half-empty mug of black coffee had gone cold beside a stack of encrypted drives.</p>
      <p style="line-height: 1.5">"You're late," she said without looking up from the monitor, her fingers flying across the mechanical keys.</p>
      <p style="line-height: 1.5" data-align="center">* * *</p>
      <p style="line-height: 1.5">Continue your next scene here…</p>
    `,
  },

  // 16. Screenplay / YouTube Video Script
  {
    id: "video-script",
    name: "Screenplay / Video Script",
    subtitle: "Visuals, B-Roll & Dialogue",
    category: "creative",
    badge: "Script",
    previewStyle: "script",
    html: `
      <p data-style="Title">EPISODE / VIDEO SCRIPT: WORKING TITLE</p>
      <p data-style="Subtitle">Target Runtime: 10–12 mins · Pacing: Fast &amp; Punchy</p>
      <hr>
      <h2>Part 1 — The Hook (0:00 – 0:45)</h2>
      <table>
        <tr>
          <th><p>Time / Cue</p></th>
          <th><p>Visual / B-Roll / Camera</p></th>
          <th><p>Audio / Voiceover / Dialogue</p></th>
        </tr>
        <tr>
          <td><p><strong>0:00 – 0:15</strong></p></td>
          <td><p>[CLOSE UP] Cold open on screen recording; rapid zoom into the key visual hook.</p></td>
          <td><p><strong>HOST (V.O.):</strong> Everyone thinks they know how this works—until you look under the hood.</p></td>
        </tr>
        <tr>
          <td><p><strong>0:15 – 0:45</strong></p></td>
          <td><p>[TITLE CARD] Motion graphic intro + subtle riser SFX.</p></td>
          <td><p><strong>HOST:</strong> Today we're breaking down the three biggest myths and testing them live.</p></td>
        </tr>
      </table>
      <h2>Part 2 — Main Breakdown (0:45 – 5:00)</h2>
      <p><strong>[INT. STUDIO - NIGHT]</strong></p>
      <p>Write scene action, talking points, or dialogue blocks here…</p>
    `,
  },
];

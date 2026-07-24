# Bee Organized Master Email Content

Source: `BO_Zee_Bee_Emails.docx` (provided by Kevin / Bee Organized corporate).

Use this as the verbatim source for seeding master drip path
templates. Do not paraphrase. Convert Zoho-style placeholders
(`${Requests.First Name}`, `${Lookup:Location.Location Owner}`, etc.)
to Bee Hub format per the variable mapping section below.

---

## Variable Mapping (Zoho → Bee Hub)

| Zoho placeholder | Bee Hub | Source |
|---|---|---|
| `${Requests.First Name}` | `{{first_name}}` | lead.first_name |
| `${Contacts.First Name}` | `{{first_name}}` | lead.first_name |
| `${Requests.Request Owner}` | `{{owner_name}}` | assigned_to.full_name |
| `${Lookup:Request Owner.First Name}` | `{{owner_first_name}}` | assigned_to.first_name |
| `${Opportunities.Opportunity Owner}` | `{{owner_name}}` | assigned_to.full_name |
| `${Lookup:Location.Location Owner}` | `{{location_owner_name}}` | location's owner.full_name |
| `${Lookup:Location.Rate Per Hour}` | `{{rate_per_hour}}` | locations.rate_per_hour |
| `${Lookup:Location.Phone Number}` | `{{location_phone}}` | locations.phone |
| `${Lookup:Location.Book Assessment Link}` | `{{book_assessment_link}}` | locations.calendar_link |
| _(no Zoho equivalent)_ | `{{owner_booking_link}}` | assigned_to.booking_link → location owner's booking_link → locations.calendar_link |
| `${Lookup:Location.Google Reviews}` | `{{reviews_link}}` | locations.reviews_link |
| `{Partner}` | `{{partner_name}}` | (Partner Drip — Phase 2) |

---

## Module Mappings

| Doc says | Bee Hub equivalent |
|---|---|
| New Lead Emails (Leads module) | New Lead Drip, triggers when stage='New' |
| Welcome Email (Contacts module) | Auto-fires 24h after Email 1 of any new lead path |
| Opportunity Stages Drip (Opportunities module) | Stage-transition drips |
| Partner Drip Emails (Partners module) | Phase 2 — not implementing now |
| Profile Quiz Drip | NOT ACTIVE — skip |

---

## New Lead Drip — Organizing (Not Move)

Trigger: lead.stage = 'New' AND project_type = 'organizing' (or "not move")

### Organizing — Path A

**Email 1** (delay: 0 days — immediately after conversion)

> Hello {{first_name}}, and thank you so much for reaching out. We would be HONORED to work with you!
>
> We'd be happy to schedule a complimentary in-home assessment of your project. During this brief (approximately 30-minute) visit, we will discuss what's working well, what isn't, your current challenges and your overall goals. Do you have availability sometime this week?
>
> Following the assessment, we'll be able to provide an estimate of time and associated costs. Our rate starts at {{rate_per_hour}} per hour per Bee. We will source and bring recommended products on your scheduled project day, and we will include those product costs on your final invoice. We typically schedule projects on weekdays between 9:00 a.m. and 3:00 p.m.
>
> Thank you in advance for considering Bee Organized to help Simplify Your Hive! We look forward to connecting with you soon!
>
> Thank you,
>
> {{owner_name}}
>
> Be sure to check out our Google Reviews! ({{reviews_link}})

**Email 2** (delay: 5 days)

> {{first_name}},
>
> We would be honored to support you with your project. We'd love to schedule a complimentary assessment where we can meet with you to discuss your needs, priorities and timeline. From there, we'll put together an estimate and outline next steps and timing.
>
> Please let me know if you're still interested and what your availability looks like so we can schedule this time together.
>
> We look forward to connecting with you!
>
> Thank you,
>
> {{location_owner_name}}
>
> Have you ever considered your relationship with your stuff and how it plays a role in your organization? Take our Bee Organized Profiles Quiz (https://beeorganized.com/organizing-profile-quiz/) to see what organizing profile you are and how understanding it can help you in your journey to Bee Organized!

**Email 3** (delay: 30 days)

> Hi {{first_name}},
>
> Still interested in the benefits of organization? We've been trying to connect with you to schedule a complimentary assessment and wanted to check back in.
>
> It would be our HONOR to connect with you, please let us know your availability so we can schedule time to talk through your goals and see how we can best support you.
>
> We look forward to hearing from you!
>
> Thank you,
>
> {{location_owner_name}}

### Organizing — Path B

**Email 1** (delay: 0 days)

> Hello {{first_name}}, and thank you so much for reaching out. We would be HONORED to work with you!
>
> The first step is to set up a complimentary "Discovery Call." During this brief (approximately 30-minute) call, we'll discuss what's working well, what isn't, your current challenges and your overall goals. Please click HERE ({{book_assessment_link}}) to select a day and time that will work best for you.
>
> The preferred format of these calls is via video call so she can see the spaces you're interested in organizing. If you'd prefer to chat by phone, or would like to request an in-person assessment, please select a day and time and also send an email indicating that request. We will do our best to accommodate your preference.
>
> Following the Discovery Call and/or assessment, we'll be able to provide an Estimate of time and associated costs. Our rate starts at {{rate_per_hour}} per hour per Bee. We will source and bring recommended products on your scheduled project day, and we will include those product costs on your final invoice. We typically schedule projects on weekdays between 9:00 a.m. and 3:00 p.m.
>
> Thank you in advance for considering Bee Organized to help Simplify Your Hive! We look forward to connecting with you soon!
>
> Thank you,
>
> {{owner_first_name}}
>
> Be sure to check out our Google Reviews! ({{reviews_link}})

**Email 2** (delay: 5 days)

> Hello {{first_name}},
>
> We're simply following up to see if you'd like to schedule a time to discuss your project.
>
> Please feel free to schedule a complimentary "Discovery Call." During this brief (approximately 30-minute) call, we'll discuss your goals, priorities and timeline. Please click here ({{book_assessment_link}}) to select a day and time that will work best for you. Please note that this will be a video call, if you prefer to chat over the phone or would like to schedule an in-person assessment, please schedule time using the calendar link and email me with your preferences.
>
> We look forward to connecting with you!
>
> Thank you,
>
> {{location_owner_name}}
>
> Have you ever considered your relationship with your stuff and how it plays a role in your organization? Take our Bee Organized Profiles Quiz (https://beeorganized.com/organizing-profile-quiz/) to see what organizing profile you are and how understanding it can help you in your journey to Bee Organized!

**Email 3** (delay: 30 days)

> Hello {{first_name}},
>
> Still interested in the benefits of organization? The first step is to set up a complimentary "Discovery Call." During this brief (approximately 30-minute) call, we'll discuss your goals, priorities and timeline. Please click here ({{book_assessment_link}}) to select a day and time that will work best for you.
>
> It would be our HONOR to connect and see how we can best support you.
>
> We look forward to hearing from you!
>
> Thank you,
>
> {{location_owner_name}}

### Organizing — Path C

**Email 1** (delay: 0 days)

> {{first_name}},
>
> Hello, and thank you so much for reaching out, we would be HONORED to work with you!
>
> We would love to start with a Discovery call to share a little more about our company, process, pricing and learn more about your project. Do you have availability sometime this week?
>
> Thank you in advance for considering Bee Organized to help Simplify Your Hive! We look forward to connecting with you soon!
>
> Thank you,
>
> {{owner_name}}
>
> Be sure to check out our Google Reviews! ({{reviews_link}})

**Email 2** (delay: 5 days)

> Hi {{first_name}},
>
> We would be honored to support your with your project! We'd love to schedule a Discovery Call to learn more about your project and goals. Please let me know if you're still interested and what your availability looks like so we can schedule this time together.
>
> We look forward to connecting with you!
>
> Thank you,
>
> {{location_owner_name}}
>
> Have you ever considered your relationship with your stuff and how it plays a role in your organization? Take our Bee Organized Profiles Quiz to see what organizing profile you are and how understanding it can help you in your journey to Bee Organized!

**Email 3** (delay: 30 days)

> {{first_name}},
>
> Still interested in the benefits of organization? We've been trying to connect with you to schedule a discovery call and wanted to check back in.
>
> It would be our HONOR to connect with you, please let us know your availability so we can schedule time to talk through your goals and see how we can best support you.
>
> We look forward to hearing from you!
>
> Thank you,
>
> {{location_owner_name}}

### Organizing — Path D

**Email 1** (delay: 0 days)

> {{first_name}},
>
> Hello, and thank you so much for reaching out, we would be HONORED to work with you! We would love to start with a Discovery call to share a little more about our company, process, pricing and learn more about your project. Do you have availability sometime this week?
>
> To make it easier to find a time, click here ({{book_assessment_link}}) to select a time that works best for you. Or feel free to give me a call or text me at {{location_phone}}.
>
> Thank you in advance for considering Bee Organized to help Simplify Your Hive! We look forward to connecting with you soon!
>
> Thank you,
>
> {{owner_name}}
>
> Be sure to check out our Google Reviews! ({{reviews_link}})

**Email 2** (delay: 5 days)

> Hi {{first_name}},
>
> We're simply following up to see if you'd like to schedule a time to discuss your project.
>
> Please feel free to schedule a complimentary "Discovery Call." During this brief (approximately 30-minute) call, we'll discuss your move and timeline. Please click here ({{book_assessment_link}}) to select a day and time that will work best for you. Or feel free to give me a call or text me at {{location_phone}}.
>
> Thank you,
>
> {{location_owner_name}}
>
> Have you ever considered your relationship with your stuff and how it plays a role in your organization? Take our Bee Organized Profiles Quiz (https://beeorganized.com/organizing-profile-quiz/) to see what organizing profile you are and how understanding it can help you in your journey to Bee Organized!

**Email 3** (delay: 30 days)

> {{first_name}},
>
> Still interested in the benefits of organization? The first step is to set up a complimentary "Discovery Call". During this brief (approximately 30-minute) call, we'll discuss your goals, priorities and timeline. Please click here ({{book_assessment_link}}) to select a day and time that will work best for you.
>
> It would be our HONOR to connect with you and see how we can best support you.
>
> We look forward to hearing from you!
>
> Thank you,
>
> {{location_owner_name}}

---

## New Lead Drip — Moving

Trigger: lead.stage = 'New' AND project_type = 'moving'

### Moving — Path A

**Email 1** (delay: 0 days)

> Hello {{first_name}}, and thank you so much for reaching out.
>
> We would be happy to schedule a complimentary assessment of your project. During this brief (approximately 30-minute) visit, we will discuss your move details, priorities and timeline. Do you have availability sometime this week?
>
> Following the assessment, we will provide an estimate of time and associated costs. Our rate starts at {{rate_per_hour}} per hour per Bee. We will source and bring recommended supplies needed (boxes, packing paper, etc.) on your scheduled project day, and will include those costs on your final invoice. We typically schedule projects on weekdays between 9:00 a.m. and 3:00 p.m.
>
> Thank you in advance for considering Bee Organized to help Simplify Your Move! We look forward to connecting with you soon!
>
> Thank you,
>
> {{owner_name}}
>
> Be sure to check out our Google Reviews! ({{reviews_link}})

**Email 2** (delay: 5 days)

> {{first_name}},
>
> We are checking back to see if you would like to schedule a complimentary assessment to discuss your move, priorities and timeline. From there, an estimate and outline of next steps and timing will be provided. We would be HONORED to work with you!
>
> Please let me know if you're still interested and what your availability looks like so we can schedule this time together.
>
> We look forward to connecting with you!
>
> Thank you,
>
> {{location_owner_name}}

**Email 3** (delay: 30 days)

> Hi {{first_name}},
>
> Still interested in working with us on your upcoming move? We've been trying to connect with you to schedule a complimentary assessment and wanted to check back in.
>
> Please let us know your availability. We would be HONORED to help!
>
> We look forward to hearing from you!
>
> Thank you,
>
> {{location_owner_name}}

### Moving — Path B

**Email 1** (delay: 0 days)

> Hello {{first_name}}, and thank you so much for reaching out. We would be HONORED to work with you!
>
> The first step is to set up a complimentary "Discovery Call." During this brief (approximately 30-minute) call, we'll discuss your upcoming move, priorities and timeline. Please click here ({{book_assessment_link}}) to select a day and time that will work best for you.
>
> The preferred format of these calls is via video call so we can see the spaces you will be moving. If you'd prefer to chat by phone, or would like to request an in-person assessment, please select a day and time and also send an email indicating that request. We will do our best to accommodate your preference.
>
> Following the Discovery Call and/or assessment, we'll be able to provide an Estimate of time and associated costs. Our rate starts at {{rate_per_hour}} per hour per Bee. We will source and bring recommended supplies needed (boxes, packing paper, etc.) on your scheduled project day, and we will include those costs on your final invoice. We typically schedule projects on weekdays between 9:00 a.m. and 3:00 p.m.
>
> Thank you in advance for considering Bee Organized to help Simplify Your Move! We look forward to connecting with you soon!
>
> Thank you,
>
> {{owner_first_name}}
>
> Be sure to check out our Google Reviews! ({{reviews_link}})

**Email 2** (delay: 5 days)

> Hello {{first_name}},
>
> We're simply following up to see if you'd like to schedule a time to discuss your project.
>
> Please feel free to schedule a complimentary "Discovery Call." During this brief (approximately 30-minute) call, we'll discuss your move details, priorities and timeline. Please click here ({{book_assessment_link}}) to select a day and time that will work best for you. Please note that this will be a video call, if you prefer to chat over the phone or would like to schedule an in-person assessment, please schedule time using the calendar link and email me with your preferences.
>
> We look forward to connecting with you!
>
> Thank you,
>
> {{location_owner_name}}

**Email 3** (delay: 30 days)

> Hello {{first_name}},
>
> Still interested in working with us on your upcoming move? The first step is to set up a complimentary "Discovery Call". During this brief (approximately 30-minute) call, we'll discuss your goals, priorities and timeline. Please click here ({{book_assessment_link}}) to select a day and time that will work best for you.
>
> It would be our HONOR to connect with you and see how we can best support you.
>
> We look forward to hearing from you!
>
> {{location_owner_name}}

### Moving — Path C

**Email 1** (delay: 0 days)

> {{first_name}},
>
> Hello, and thank you so much for reaching out, we would be HONORED to work with you!
>
> We would love to start with a Discovery call to share a little more about our company, process, pricing and learn more about your project. Do you have availability sometime this week?
>
> Thank you in advance for considering Bee Organized to help Simplify Your Move! We look forward to connecting with you soon!
>
> Thank you,
>
> {{owner_name}}
>
> **Be sure to check out our Google Reviews!** ({{reviews_link}})

**Email 2** (delay: 5 days)

> Hi {{first_name}},
>
> We would be honored to support you with your upcoming move. We'd love to schedule a Discovery Call to learn more about your move project and timeline. Please let me know if you're still interested and what your availability looks like so we can schedule this time together.
>
> We look forward to connecting with you!
>
> Thank you,
>
> {{location_owner_name}}

**Email 3** (delay: 30 days)

> {{first_name}},
>
> Still interested in working with us on your upcoming move? We've been trying to connect with you to schedule a discovery call and wanted to check back in.
>
> It would be our HONOR to connect with you, please let us know your availability so we can schedule time to talk through your move and see how we can best support you.
>
> We look forward to hearing from you!
>
> Thank you,
>
> {{location_owner_name}}

### Moving — Path D

**Email 1** (delay: 0 days)

> {{first_name}},
>
> Hello, and thank you so much for reaching out, we would be HONORED to work with you! We would love to start with a Discovery call to share a little more about our company, process, pricing and learn more about your upcoming move. Do you have availability sometime this week?
>
> To make it easier to find a time, click here ({{book_assessment_link}}) so you can select a time that works best for you. Or feel free to give me a call or text me at {{location_phone}}.
>
> Thank you in advance for considering Bee Organized to help Simplify Your Move! We look forward to connecting with you soon!
>
> Thank you,
>
> {{owner_name}}
>
> Be sure to check out our Google Reviews! ({{reviews_link}})

**Email 2** (delay: 5 days)

> Hi {{first_name}},
>
> We're simply following up to see if you'd like to schedule a time to discuss your move project.
>
> Please feel free to schedule a complimentary "Discovery Call." During this brief (approximately 30-minute) call, we'll discuss your move and timeline. Please click here ({{book_assessment_link}}) to select a day and time that will work best for you. Or feel free to give me a call or text me at {{location_phone}}.
>
> Thank you,
>
> {{location_owner_name}}
>
> Have you ever considered your relationship with your stuff? Take our Bee Organized Profiles Quiz (https://beeorganized.com/organizing-profile-quiz/) to see what organizing profile you are and how understanding it can help you in your journey to Bee Organized!

**Email 3** (delay: 30 days)

> {{first_name}},
>
> Still interested in working with us on your upcoming move? The first step is to set up a complimentary "Discovery Call". During this brief (approximately 30-minute) call, we'll discuss your move project, details and timeline. Please click here ({{book_assessment_link}}) to select a day and time that will work best for you.
>
> It would be our HONOR to connect with you and see how we can best support you.
>
> We look forward to hearing from you!
>
> Thank you,
>
> {{location_owner_name}}

---

## Welcome Email

Trigger: 24 hours after Email 1 of ANY new lead drip path fires.
Single template, same content regardless of path.

**Subject:** Welcome to the Bee Organized Hive!

**Body:**

> Welcome to the Bee Organized Hive! We're excited to connect with you soon and it would be our HONOR to help you *Simplify Your Hive!*
>
> Check out more info about **Bee Organized** below…
>
> **What's Your Organizing Profile?**
> Take our fun Organizing Profile Quiz here (https://beeorganized.com/) to find out who you are in relationship with your stuff!
>
> **How We Came To Bee**
> Learn how these best friends got started and built a successful national franchise business here! (https://beeorganized.com/pages/how-we-came-to-bee)

---

## Opportunity Stages Drip

These trigger on lead stage transitions.

### Closed Job — 3 month follow up

Trigger: 90 days after lead.stage transitions to 'Closed Won'

> {{first_name}},
>
> Hello! We hope you are still thrilled with our services. If you haven't already taken advantage of our offer, as an appreciation of your time and completing the Google Review, we would like to provide 1 Free Hour (with 3 Hours Booked) off your next service booked with Bee Organized!
>
> We would also love to stay connected with our Maintenance Program where we can continue to help you Simplify your home throughout the year. Our Maintenance Program allows you to maintain the work that we did together where we could come as often as each month or quarterly.
>
> It was an HONOR to have worked with you and we look forward to working with you again in the future!
>
> Best,
>
> {{owner_name}}

### Closed Job — 12 month follow up

Trigger: 365 days after lead.stage transitions to 'Closed Won'

> {{first_name}},
>
> We hope you've been doing well! We were thinking of you and wanted to reach out as it's been about a year since we had the pleasure of working with you.
>
> We know life changes quickly, and even the best systems can need a refresh over time. Whether your space is still working beautifully or you've noticed areas that could use a little extra support, we're always happy to help.
>
> If you have any questions, need a seasonal reset, or would like to schedule time to fine-tune your systems, please don't hesitate to reach out. And of course, if everything is still working great, we love hearing that too!
>
> It was truly an HONOR to work with you, and we hope to connect again whenever the time feels right.
>
> Warmly,
>
> {{owner_name}}

### Organizing | Estimate Follow-up | 3 days after send

Trigger: 3 days after lead.stage transitions to 'Estimate Sent' AND project_type = 'organizing'

> {{first_name}},
>
> Hello! It was an HONOR connecting with you and discussing how Bee Organized can help you Simplify Your Hive!
>
> We wanted to follow up as we recently sent over your estimate and haven't heard back yet. Once we receive your approval, we'll be happy to reach out to discuss scheduling and introduce you to your Bees.
>
> Please let us know if you have any questions or if there's anything we can clarify, it would be an HONOR to work with you!
>
> Thank you,
>
> {{owner_name}}

### Organizing | Estimate Follow-up | 30 days after send

Trigger: 30 days after lead.stage transitions to 'Estimate Sent' AND project_type = 'organizing'

> {{first_name}},
>
> We wanted to reach out one last time regarding the estimate we shared for your organizing project.
>
> At Bee Organized, our goal is to help you Simplify Your Hive by creating systems that are functional, sustainable, and tailored to how you live. If you're still interested in moving forward, we'd love the opportunity to schedule your project and introduce you to your Bees.
>
> If now isn't the right season, no worries at all, just let us know. And if you have any questions about the estimate or the process, we're always happy to help.
>
> Thank you again for considering Bee Organized. It would truly be an HONOR to work with you.
>
> Warmly,
>
> {{owner_name}}

### Moving | Estimate Follow-up | 3 days after send

Trigger: 3 days after lead.stage transitions to 'Estimate Sent' AND project_type = 'moving'

> {{first_name}},
>
> Hello! It was an HONOR connecting with you and discussing how Bee Organized can help you Simplify Your Move!
>
> We wanted to follow up as we recently sent over your estimate and haven't heard back yet. Once we receive your approval, we'll be happy to reach out to discuss scheduling and introduce you to your Bees.
>
> Please let us know if you have any questions or if there's anything we can clarify, it would be an HONOR to work with you!
>
> Thank you,
>
> {{owner_name}}

### Moving | Estimate Follow-up | 30 days after send

Trigger: 30 days after lead.stage transitions to 'Estimate Sent' AND project_type = 'moving'

> {{first_name}},
>
> We wanted to reach out one last time regarding the estimate we shared for your move project.
>
> At Bee Organized, our goal is to help you Simplify Your Move by creating systems that are functional, sustainable, and tailored to how you live. If you're still interested in moving forward, we'd love the opportunity to schedule your project and introduce you to your Bees.
>
> If you have any questions about the estimate or the process, we're always happy to help.
>
> Thank you again for considering Bee Organized. It would truly be an HONOR to work with you.
>
> Warmly,
>
> {{owner_name}}

---

## Partner Drip — PHASE 2 (do not seed now)

The Partner Drip emails exist in the source doc but are deferred to
Phase 2. They require a partners entity that doesn't exist in Bee Hub
yet. Skip implementation for this commit.

---

## Profile Quiz Drip — NOT ACTIVE

The Profile Quiz Drip exists in the source doc but is marked
"NOT ACTIVE" by Bee Organized. Skip.

---

## Subject Lines

The source doc primarily provides body content. Suggested subjects
to derive (Claude Code may pick alternatives that match Bee Hub's
existing voice):

- New Lead Drip Email 1: "Thank you for reaching out!"
- New Lead Drip Email 2: "Following up on your project"
- New Lead Drip Email 3: "Still interested?"
- Welcome Email: "Welcome to the Bee Organized Hive!"
- Closed Job 3mo: "We hope you're still loving your space!"
- Closed Job 12mo: "It's been a year — how is your space holding up?"
- Estimate Follow-up 3 day: "Following up on your estimate"
- Estimate Follow-up 30 day: "One last note on your estimate"

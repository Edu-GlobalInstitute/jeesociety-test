/**
 * The landing page. Written for a student deciding whether to sit this, and for
 * the parent paying for it — so it leads with what the paper actually is, and
 * says plainly what happens if their connection fails mid-test, because that is
 * the question people actually ask.
 */
export default function Home() {
  return (
    <main>
      <section className="wrap hero">
        <h1 className="hero__title">A full JEE paper, sat on the same day across India.</h1>
        <p className="hero__lede">
          Sixty objective questions and fifteen written ones, in three hours. Objective results
          the next morning; your all-India rank within six days.
        </p>
        <a className="btn" href="/register">
          Register for the test
        </a>

        <div className="spec" style={{ marginTop: 36 }}>
          <div className="spec__cell">
            <span className="spec__value tnum">75</span>
            <span className="spec__label">questions</span>
          </div>
          <div className="spec__cell">
            <span className="spec__value tnum">3h</span>
            <span className="spec__label">one sitting</span>
          </div>
          <div className="spec__cell">
            <span className="spec__value tnum">+4 / −1</span>
            <span className="spec__label">objective marking</span>
          </div>
          <div className="spec__cell">
            <span className="spec__value tnum">6 days</span>
            <span className="spec__label">to final ranks</span>
          </div>
        </div>
      </section>

      <section className="wrap section">
        <h2 className="section__title">What the paper contains</h2>
        <div className="prose">
          <p>
            <strong>Sixty objective questions</strong> across physics, chemistry and mathematics,
            marked the way JEE marks them: four for a correct answer, minus one for a wrong one,
            nothing for a question you leave alone.
          </p>
          <p>
            <strong>Fifteen written questions</strong> where you show your working. These are read
            against a published rubric — method, setup, calculation, and a final answer with its
            units — and worth up to three marks each. Every low-confidence grade is read by a
            person before your result is final.
          </p>
        </div>
      </section>

      <section className="wrap section">
        <h2 className="section__title">If something goes wrong during the test</h2>
        <div className="prose">
          <p>
            Your answers save to your own device as you type, and to our servers every ninety
            seconds. If your connection drops, <strong>keep working</strong> — your answers are
            held on your machine and sent when it comes back.
          </p>
          <p>
            If your machine dies and never comes back, your test is still completed and still
            marked, using everything we had received from you. The most you can lose is the last
            ninety seconds of typing.
          </p>
          <p>
            If you cannot press submit, that is fine too. We finalise every unsubmitted test
            automatically after the window closes. The submit button is a convenience, not a
            requirement.
          </p>
        </div>
      </section>

      <section className="wrap section">
        <h2 className="section__title">How to take part</h2>
        <ol className="steps">
          <li>
            <div>
              <strong>Register and pay.</strong> Do this well before the day — registration closes
              the moment the test begins.
            </div>
          </li>
          <li>
            <div>
              <strong>Arrive in the waiting room.</strong> It opens thirty minutes before the
              start and checks that your browser can save and send your answers.
            </div>
          </li>
          <li>
            <div>
              <strong>Sit the test.</strong> The paper opens by itself when the clock reaches
              zero. Your timer runs on our clock, not your computer&rsquo;s.
            </div>
          </li>
          <li>
            <div>
              <strong>Keep your receipt.</strong> You get one when you submit. Quote it if you
              ever need to ask us anything about this test.
            </div>
          </li>
        </ol>
      </section>
    </main>
  );
}

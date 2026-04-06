check my claud.md, please also read all the .txt files  so you understand the overall purpose of the project. before any code or edition of code base, first i want to think about how to structure the architecture for the way im going to relate rate requests, rate submissions and actual rates. because this is going to be affecting or shaping the view on both ends the requester and provider. so  I want to set up 3 types of elements or objects for requesting and getting rates from forwarders (or providers)

so the MUI x grid that I created already has the purpose of creating a 'rate request" list or batch. a rate request is just a template for forwarders to know what lanes or port pairs we are interested in getting rates for. but in reality forwarders can submit rates for any given lane or route. the 'rate request' element or approach just works for we all be aligned in what we want and what they have for us.

I decided to do it this way because rates have a validity period set and at the same time our need or demand for rates is also by periods, given that we do it in the basis of our need for importing goods. lets say they have goods ready to ship from nhava sheva, india - Commerce, ca. on jan 1st but maybe we are going to need rates on the following period jan 14th or maybe in feb 1st.

so i want to make rate request short lived (14 days). everyime we post a lane in a rate request lane will mean "we are interested in quoting this" and forwarders will be able to see this template if the rate request is still active, meaning we are within the 14 days after posted.

they will see nhava sheva, india - Commerce, ca and they can add the rate data -- > port of discharge, last container yard, rate, rate validity, carrier and notes.
e.g. POL: Nhava Sheva, India, POD: Los Angeles, CA LASTCY: Los Angeles, CA, $2000, valid until april 14, MSC, "some notes"



so the way im going to be storing rates is actually very simple and straight forward given that rates have their own characteristics and have their own validity period.

what I want to structure is how "rate requests" are handled and Once they fill in a template or 'rate request" i want this element or object to be a "rate submission" (pure rates are stored additionally in the background as rates)

so the view for the forwarder should be active 'rate requests' that have not been provided rates for. I can set two views. like pending "rates requests" and "submitted rates" (which is just a rate request template with data filled in)

but i dont want them to see historic rates request or rate submissions. instead for 'rate requests' only active ones meaning posted in less than 14 days. for rate submissions I want them to see only rates requested in the past 30 days. so essentially rates request templates posted by the requester in the past 30 days + rates provided by them
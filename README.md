# JEICalculator - Static Website


### TODO
- [ ] Make invalid search return item not found
- [ ] Create a search bar helper
- [ ] Toggle to hide emc items from raw materials
- [ ] Limit tree by total node count, not depth

- [x] Images
- [ ] Small icon next to each node
- [ ] Handle ore dictionary
- [x] Multiply ingredient nodes to produce output
- [x] Create sidebar for to aggregate materials
- [x] Get machine rates, such as speed and energy costs
- [x] Read tooltip for emc
- [x] Tree search bar and focus
- [x] Clicking the item in the sidebar will highlight the nodes associated with it
- [x] Enable rebuilding of the tree by selecting alternative routes
- [x] Enable the marking of nodes as "Passive", which will stop further nodes from propagating
- [ ] Cache generated trees
- [ ] Cache search bar helper
- [x] ~~Cache loaded recipe file~~ Lazy load recipes based on category
- [ ] MMCE upgrades (no idea how I'm going to autogenerate these)
- [ ] Limit the height of the canvas and spread the tree across a greater area
- [ ] Item vs fluid handling
- [ ] Initially expanded alt does not show current active
- [x] Add timers to show loading speeds
- [x] Filter out fluid filling / extracting recipes
- [x] Add machine priority between similar machines
- [ ] Remove redundant recipes when there is a clear upgrade
- [ ] Someday get rid of the item: tag before every item
- [x] Order raw materials by quantity
- [ ] Toggle fluids and items in raw materials
- [ ] Add quantity for root item
- [ ] Extract reusable from tooltip
- [x] Handle recursive recipes
- [ ] Make alternatives panel disapear on mouse click
- [ ] Remove alternatives button for leaf + passive nodes
- [ ] Items in passived should be able to be expanded if it is the root
- [ ] Redo passived tab
- [ ] Add recipe card previews when hovering over alteranatives
- [ ] Zoom smoothing
- [ ] Passive item should accept both id and name

### BUGS
- [ ] Sidebar first click expands then views, should do both in 1 click
- [ ] Fix rendering issue. Idk why it happens
- [ ] Collapse all should reset view
### RECIPE FILTERING
- [x] Remove runic altar from runic altar recipes
- [x] Thaumotorium automation
- [ ] Resource miners
- [x] Master of spellcraft
- [x] HNN
- [x] living recursive essence
- [x] biome item
- [x] remove EIO power
- [x] Terminate all essentia by removing inputs from mechanized essentia smeltery
- [ ] Fix essentia quantity
- [x] Remove NC collector inputs
- [ ] Pure void, seared caster recipe missing
- [x] Mechanized coops
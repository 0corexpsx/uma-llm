const walks = document.querySelectorAll('.walks article');

walks.forEach((walk, index) => {
  walk.addEventListener('click', () => {
    walk.classList.toggle('is-open');
    console.info('walk selected', index + 1);
  });
});
